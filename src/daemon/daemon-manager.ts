import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

// Manages the Chorus daemon bundled with this plugin (daemon/chorus-daemon.mjs,
// vendored by scripts/sync-daemon.mjs). The daemon is an independent 24/7
// process that wakes local agents on platform dispatch — it must outlive
// OpenCode sessions, so this manager never runs it in-process: it installs the
// single-file bundle into a STABLE directory (~/.chorus/runtime — the plugin
// cache path changes across versions and may be evicted) and drives it through
// the daemon's own CLI verbs with the system `node` (OpenCode embeds Bun;
// the daemon's supported runtime is Node 20+).

const execFileAsync = promisify(execFile)

export type RunResult = { code: number | null; stdout: string; stderr: string }

export type DaemonManagerIo = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  homedir(): string
  exists(target: string): boolean
  mkdir(target: string): Promise<void>
  copyFile(source: string, target: string): Promise<void>
  readFile(target: string): Promise<string>
  writeFile(target: string, content: string, options?: { encoding?: BufferEncoding; mode?: number }): Promise<void>
  remove(target: string): Promise<void>
  runCapture(command: string, args: string[]): Promise<RunResult>
}

export function defaultDaemonManagerIo(): DaemonManagerIo {
  return {
    platform: process.platform,
    env: process.env,
    homedir: () => os.homedir(),
    exists: (target) => existsSync(target),
    mkdir: async (target) => {
      await mkdir(target, { recursive: true })
    },
    copyFile: (source, target) => copyFile(source, target),
    readFile: (target) => readFile(target, "utf8"),
    writeFile: async (target, content, options) => {
      await writeFile(target, content, { encoding: options?.encoding ?? "utf8", mode: options?.mode })
    },
    remove: (target) => rm(target, { force: true }),
    runCapture: async (command, args) => {
      try {
        const { stdout, stderr } = await execFileAsync(command, args, { timeout: 120_000, windowsHide: true })
        return { code: 0, stdout, stderr }
      } catch (error) {
        const failure = error as { code?: number | string | null; stdout?: string; stderr?: string; message?: string }
        return {
          code: typeof failure.code === "number" ? failure.code : null,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? failure.message ?? String(error),
        }
      }
    },
  }
}

export type DaemonVersionInfo = {
  daemonVersion?: string
  forkCommit?: string
}

export type EnsureRuntimeResult = {
  updated: boolean
  from?: string
  to: string
  runtimeEntry: string
}

export type CtlAction = "start" | "stop" | "restart" | "status" | "logs"

export type DaemonManagerOptions = {
  chorusUrl?: string
  apiKey?: string
  /** Package root containing daemon/ — defaults to two levels above this module (dist/daemon → package root). */
  pluginRoot?: string
  io?: DaemonManagerIo
}

const RUNTIME_FILES = ["chorus-daemon.mjs", "VERSION.json", "package.json"]

export class DaemonManager {
  private readonly io: DaemonManagerIo
  private readonly pluginRoot: string
  private readonly chorusUrl?: string
  private readonly apiKey?: string

  constructor(options: DaemonManagerOptions = {}) {
    this.io = options.io ?? defaultDaemonManagerIo()
    this.pluginRoot = options.pluginRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
    this.chorusUrl = options.chorusUrl
    this.apiKey = options.apiKey
  }

  embeddedDir(): string {
    return path.join(this.pluginRoot, "daemon")
  }

  runtimeDir(): string {
    return path.join(this.io.homedir(), ".chorus", "runtime")
  }

  runtimeEntry(): string {
    return path.join(this.runtimeDir(), "chorus-daemon.mjs")
  }

  private daemonJsonPath(): string {
    return path.join(this.io.homedir(), ".chorus", "daemon.json")
  }

  private async readVersionInfo(dir: string): Promise<DaemonVersionInfo | undefined> {
    try {
      const parsed: unknown = JSON.parse(await this.io.readFile(path.join(dir, "VERSION.json")))
      return parsed && typeof parsed === "object" ? (parsed as DaemonVersionInfo) : undefined
    } catch {
      return undefined
    }
  }

  private describeVersion(info: DaemonVersionInfo | undefined): string {
    if (!info?.daemonVersion) return "unknown"
    return info.forkCommit ? `${info.daemonVersion}@${info.forkCommit}` : info.daemonVersion
  }

  /**
   * Resolve the system Node executable the daemon runs under. OpenCode's own
   * runtime is Bun (process.execPath points at it), so PATH is walked instead —
   * .exe first on Windows (the daemon CLI spawns with shell:false, which cannot
   * launch .cmd shims on Node >= 18). CHORUS_NODE_PATH overrides.
   */
  resolveNode(): string | null {
    const override = this.io.env.CHORUS_NODE_PATH
    if (override && this.io.exists(override)) return override

    const isWin = this.io.platform === "win32"
    const separators = isWin ? path.win32 : path.posix
    const names = isWin ? ["node.exe", "node.cmd", "node"] : ["node"]
    const rawPath = this.io.env.PATH || this.io.env.Path || ""
    for (const dir of rawPath.split(separators.delimiter).filter(Boolean)) {
      for (const name of names) {
        const candidate = separators.join(dir, name)
        if (this.io.exists(candidate)) return candidate
      }
    }
    return null
  }

  /** Copy the vendored daemon bundle into the stable runtime dir when missing or version-drifted. */
  async ensureRuntime(force = false): Promise<EnsureRuntimeResult> {
    const embedded = await this.readVersionInfo(this.embeddedDir())
    if (!embedded) {
      throw new Error(`embedded daemon bundle is missing at ${this.embeddedDir()} — the plugin package is broken`)
    }
    const installed = await this.readVersionInfo(this.runtimeDir())
    const upToDate =
      !force &&
      this.io.exists(this.runtimeEntry()) &&
      installed?.daemonVersion === embedded.daemonVersion &&
      installed?.forkCommit === embedded.forkCommit

    if (upToDate) {
      return { updated: false, to: this.describeVersion(embedded), runtimeEntry: this.runtimeEntry() }
    }

    await this.io.mkdir(this.runtimeDir())
    for (const file of RUNTIME_FILES) {
      await this.io.copyFile(path.join(this.embeddedDir(), file), path.join(this.runtimeDir(), file))
    }
    return {
      updated: true,
      from: installed ? this.describeVersion(installed) : undefined,
      to: this.describeVersion(embedded),
      runtimeEntry: this.runtimeEntry(),
    }
  }

  /**
   * Validate + persist daemon credentials via the daemon's own `login` verb
   * (writes ~/.chorus/daemon.json), reusing the SAME agent identity the plugin
   * runs under. Then guarantee the unattended defaults: wakeConcurrency=1 and
   * a served-directory whitelist (created on disk).
   */
  async login(workdir?: string): Promise<RunResult & { workdir: string }> {
    if (!this.chorusUrl || !this.apiKey) {
      throw new Error("Chorus credentials are not configured for this plugin (chorusUrl/apiKey) — cannot set up the daemon.")
    }
    const node = this.requireNode()
    const result = await this.io.runCapture(node, [
      this.runtimeEntry(),
      "login",
      "--url",
      this.chorusUrl,
      "--api-key",
      this.apiKey,
    ])
    if (result.code !== 0) {
      return { ...result, workdir: "" }
    }
    const resolvedWorkdir = await this.applyUnattendedDefaults(workdir)
    return { ...result, workdir: resolvedWorkdir }
  }

  /** Default served directory: D:\opencode-auto-work when D: exists (Windows), else ~/opencode-auto-work. */
  defaultWorkdir(): string {
    if (this.io.platform === "win32" && this.io.exists("D:\\")) return "D:\\opencode-auto-work"
    return path.join(this.io.homedir(), "opencode-auto-work")
  }

  private async applyUnattendedDefaults(workdir?: string): Promise<string> {
    const target = this.daemonJsonPath()
    let config: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(await this.io.readFile(target))
      if (parsed && typeof parsed === "object") config = parsed as Record<string, unknown>
    } catch {
      // login just wrote it; a read failure here still yields a valid rewrite below
    }
    // Default wake concurrency 4 (upstream default). Early pilot setups wrote 1
    // (fully serialized), which in practice just queued directed wakes behind
    // unrelated work — migrate that old default forward too.
    if (config.wakeConcurrency === undefined || config.wakeConcurrency === 1) config.wakeConcurrency = 4

    const existing = Array.isArray(config.cwds) ? (config.cwds as unknown[]).filter((c): c is string => typeof c === "string") : []
    let resolved: string
    if (workdir) {
      resolved = workdir
      if (!existing.includes(workdir)) config.cwds = [...existing, workdir]
    } else if (existing.length > 0) {
      resolved = existing[0]!
    } else {
      resolved = this.defaultWorkdir()
      config.cwds = [resolved]
    }
    await this.io.mkdir(resolved)
    await this.io.writeFile(target, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
    return resolved
  }

  /** Drive a daemon lifecycle verb through the runtime bundle's CLI. */
  async ctl(action: CtlAction): Promise<RunResult> {
    const node = this.requireNode()
    const args =
      action === "start"
        ? [this.runtimeEntry(), "daemon", "-d", "--agent", "opencode", "--yolo"]
        : [this.runtimeEntry(), "daemon", action]
    return this.io.runCapture(node, args)
  }

  /**
   * Toggle login-time autostart. Windows: a hidden-window .vbs in the user's
   * Startup folder (written UTF-16LE so non-ASCII paths survive WScript's
   * encoding rules). Elsewhere: delegate to the daemon CLI's own
   * `daemon install|uninstall` (systemd unit on Linux, printed template on macOS).
   */
  async autostart(enable: boolean): Promise<{ ok: boolean; detail: string }> {
    if (this.io.platform === "win32") {
      const appData = this.io.env.APPDATA
      if (!appData) return { ok: false, detail: "APPDATA is not set — cannot locate the Startup folder" }
      const vbsPath = path.win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "chorus-daemon-autostart.vbs")
      if (!enable) {
        await this.io.remove(vbsPath)
        return { ok: true, detail: `removed ${vbsPath}` }
      }
      const command = `cmd /c node ""${this.runtimeEntry()}"" daemon -d --agent opencode --yolo`
      const bom = "\uFEFF"
      const content = `${bom}CreateObject("WScript.Shell").Run "${command}", 0, False\r\n`
      await this.io.writeFile(vbsPath, content, { encoding: "utf16le" })
      return { ok: true, detail: `wrote ${vbsPath}` }
    }

    const node = this.requireNode()
    const args = enable
      ? [this.runtimeEntry(), "daemon", "install", "--agent", "opencode", "--yolo"]
      : [this.runtimeEntry(), "daemon", "uninstall"]
    const result = await this.io.runCapture(node, args)
    const detail = `${result.stdout}${result.stderr}`.trim()
    return { ok: result.code === 0, detail: detail || `exit ${result.code}` }
  }

  private requireNode(): string {
    const node = this.resolveNode()
    if (!node) {
      throw new Error("Node.js 20+ was not found on PATH — install Node (or set CHORUS_NODE_PATH) before managing the daemon.")
    }
    return node
  }
}
