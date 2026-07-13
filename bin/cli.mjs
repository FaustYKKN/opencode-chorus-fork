#!/usr/bin/env node
// bin/cli.mjs — opencode-chorus command line.
//
//   opencode-chorus init  [--spec <plugin-spec>] [--keep-mcp] [--config <path>]
//   opencode-chorus setup [--url <chorus-url>] [--api-key <key>] [--workdir <dir>]
//                         [--spec <plugin-spec>] [--keep-mcp] [--config <path>]
//
// `init` merges this plugin into the user's global OpenCode config so
// onboarding never requires hand-editing JSON: it adds (or replaces) the
// plugin entry and, by default, removes a native `mcp.chorus` block pointing
// at a Chorus `/api/mcp` endpoint — the plugin provides the same bridge, and
// running both channels registers confusing duplicate tools.
//
// `setup` is the full unattended onboarding in one deterministic command:
// init + install the embedded daemon runtime + login + start-at-login +
// start. It drives the same DaemonManager the chorus_daemon tool uses, but
// under plain node — no OpenCode session and no model involved, so it works
// even when the user's client cannot load plugins or the model fails to map
// "开启无人值守" to a tool call.
//
// Zero dependencies (node builtins only) so `npx <package> init` works before
// anything else is installed. Pure helpers are exported for tests.

import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Global OpenCode config file — OPENCODE_CONFIG overrides the default location. */
export function resolveConfigPath(env = process.env, home = os.homedir()) {
  if (env.OPENCODE_CONFIG && env.OPENCODE_CONFIG.trim()) return env.OPENCODE_CONFIG.trim()
  return path.join(home, ".config", "opencode", "opencode.json")
}

/** Does a plugin entry refer to THIS plugin (any name/version/scope/file:/URL form)? */
export function isThisPlugin(entry) {
  if (typeof entry !== "string") return false
  if (/^(@[^/]+\/)?opencode-chorus(@.*)?$/.test(entry)) return true
  return (entry.startsWith("file:") || /^https?:\/\//.test(entry)) && entry.includes("opencode-chorus")
}

/** Add (or replace) this plugin's entry in the config's plugin array. */
export function mergePluginEntry(config, spec) {
  const plugins = Array.isArray(config.plugin) ? [...config.plugin] : []
  const kept = plugins.filter((entry) => !isThisPlugin(entry))
  const replaced = kept.length !== plugins.length
  kept.push(spec)
  return { config: { ...config, plugin: kept }, replaced }
}

/**
 * Remove a native `mcp.chorus` block that targets a Chorus `/api/mcp` endpoint
 * (the pre-plugin integration this plugin supersedes). Anything else under
 * `mcp` — or a chorus entry that does not look like ours — is left untouched.
 */
export function stripNativeChorusMcp(config) {
  const mcp = config.mcp
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return { config, removed: false }
  const chorus = mcp.chorus
  const looksLikeOurs =
    chorus !== null &&
    typeof chorus === "object" &&
    !Array.isArray(chorus) &&
    typeof chorus.url === "string" &&
    /\/api\/mcp\/?$/.test(chorus.url)
  if (!looksLikeOurs) return { config, removed: false }

  const { chorus: _removed, ...rest } = mcp
  const next = { ...config }
  if (Object.keys(rest).length > 0) next.mcp = rest
  else delete next.mcp
  return { config: next, removed: true }
}

function ownPackage() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
}

function ownSpec() {
  const pkg = ownPackage()
  return `${pkg.name}@${pkg.version}`
}

/** npm pack's tarball filename for this package (scope flattened: @s/n → s-n). */
export function ownTarballName(pkg = ownPackage()) {
  return `${pkg.name.replace(/^@/, "").replace(/\//g, "-")}-${pkg.version}.tgz`
}

function parseArgs(argv) {
  const out = { command: argv[0], keepMcp: false }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--spec") out.spec = argv[++i]
    else if (arg.startsWith("--spec=")) out.spec = arg.slice("--spec=".length)
    else if (arg === "--config") out.configPath = argv[++i]
    else if (arg.startsWith("--config=")) out.configPath = arg.slice("--config=".length)
    else if (arg === "--keep-mcp") out.keepMcp = true
    else if (arg === "--url") out.url = argv[++i]
    else if (arg.startsWith("--url=")) out.url = arg.slice("--url=".length)
    else if (arg === "--api-key") out.apiKey = argv[++i]
    else if (arg.startsWith("--api-key=")) out.apiKey = arg.slice("--api-key=".length)
    else if (arg === "--workdir") out.workdir = argv[++i]
    else if (arg.startsWith("--workdir=")) out.workdir = arg.slice("--workdir=".length)
  }
  return out
}

export function runInit(options = {}, io = {}) {
  const read = io.readFileSync ?? readFileSync
  const write = io.writeFileSync ?? writeFileSync
  const ensureDir = io.mkdirSync ?? ((dir) => mkdirSync(dir, { recursive: true }))
  const exists = io.existsSync ?? existsSync
  const log = io.log ?? console.log

  const target = options.configPath ?? resolveConfigPath(io.env ?? process.env, io.home ?? os.homedir())
  const spec = options.spec ?? ownSpec()

  let config = {}
  if (exists(target)) {
    const raw = read(target, "utf8")
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed
      else throw new Error("not an object")
    } catch (error) {
      throw new Error(`${target} is not valid JSON (${error instanceof Error ? error.message : error}) — fix or remove it, then re-run init`)
    }
  } else if (!config["$schema"]) {
    config["$schema"] = "https://opencode.ai/config.json"
  }

  const merged = mergePluginEntry(config, spec)
  let next = merged.config
  let removedMcp = false
  if (!options.keepMcp) {
    const stripped = stripNativeChorusMcp(next)
    next = stripped.config
    removedMcp = stripped.removed
  }

  ensureDir(path.dirname(target))
  write(target, JSON.stringify(next, null, 2) + "\n")

  log(`plugin entry ${merged.replaced ? "replaced" : "added"}: ${spec}`)
  if (removedMcp) log("removed the native mcp.chorus block (the plugin provides the same bridge)")
  log(`written: ${target}`)
  if (options.nextHint !== false)
    log('next: run "opencode-chorus setup" (or ask the OpenCode agent to enable unattended mode) to bring the daemon up')
  return { target, spec, replaced: merged.replaced, removedMcp }
}

async function loadDaemonManager() {
  const mod = await import(new URL("../dist/daemon/daemon-manager.js", import.meta.url).href)
  return mod.DaemonManager
}

/**
 * OpenCode's skill discovery shells out to ripgrep; on a missing `rg`,
 * OpenCode tries to download it FROM GITHUB — which fails on intranet
 * machines, and with it the whole chorus skill ("Skill chorus failed:
 * ripgrep execution failed"). Install rg from the Chorus platform instead,
 * into OpenCode's own managed location (~/.cache/opencode/bin), which both
 * the CLI and the desktop client consult before downloading.
 *
 * Returns { ok, detail, installed }. Failure is reported, never thrown —
 * the daemon works without skills; they just make sessions smarter.
 */
export async function ensureRipgrep(chorusUrl, io = {}) {
  const platform = io.platform ?? process.platform
  const home = io.home ?? os.homedir()
  const exists = io.existsSync ?? existsSync
  const binDir = path.join(home, ".cache", "opencode", "bin")
  const rgPath = path.join(binDir, platform === "win32" ? "rg.exe" : "rg")

  if (exists(rgPath)) return { ok: true, installed: false, detail: `ripgrep already present at ${rgPath}` }
  const onPath = io.whichRg ?? (() => {
    const probe = spawnSync(platform === "win32" ? "where" : "which", ["rg"], { encoding: "utf8" })
    return probe.status === 0
  })
  if (onPath()) return { ok: true, installed: false, detail: "ripgrep already on PATH" }

  const archive = platform === "win32" ? "ripgrep-win64.zip" : "ripgrep-linux-x64.tar.gz"
  const url = `${chorusUrl}/${archive}`
  try {
    const download = io.download ?? (async (target) => {
      const res = await fetch(target)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    })
    const buffer = await download(url)

    const extract = io.extract ?? ((archiveBuffer) => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "chorus-rg-"))
      try {
        const archivePath = path.join(tmp, archive)
        writeFileSync(archivePath, archiveBuffer)
        // bsdtar (Windows 10+, macOS, most Linuxes) reads both zip and tar.gz.
        const untar = spawnSync("tar", ["-xf", archivePath, "-C", tmp], { encoding: "utf8" })
        if (untar.status !== 0) throw new Error(`tar failed: ${(untar.stderr || "").trim() || `exit ${untar.status}`}`)
        const wanted = platform === "win32" ? "rg.exe" : "rg"
        const found = findFileRecursive(tmp, wanted)
        if (!found) throw new Error(`${wanted} not found inside ${archive}`)
        mkdirSync(binDir, { recursive: true })
        copyFileSync(found, rgPath)
        if (platform !== "win32") chmodSync(rgPath, 0o755)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })
    extract(buffer)
    return { ok: true, installed: true, detail: `installed ripgrep to ${rgPath} (from ${url})` }
  } catch (error) {
    return {
      ok: false,
      installed: false,
      detail: `could not install ripgrep from ${url}: ${error instanceof Error ? error.message : error} — skills will be unavailable until rg.exe is placed in ${binDir} manually`,
    }
  }
}

function findFileRecursive(dir, name) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      const nested = findFileRecursive(full, name)
      if (nested) return nested
    } else if (entry === name) {
      return full
    }
  }
  return null
}

/**
 * Full unattended onboarding in one command: write the plugin config (init),
 * then drive the embedded daemon manager — install runtime, login with
 * unattended defaults, enable start-at-login, start, report status. Pure node;
 * needs no OpenCode session. Idempotent: re-running refreshes every step.
 */
export async function runSetup(options = {}, io = {}) {
  const log = io.log ?? console.log
  const env = io.env ?? process.env

  const chorusUrl = (options.url ?? env.CHORUS_BASE_URL ?? env.CHORUS_URL ?? "").trim().replace(/\/+$/, "")
  const apiKey = (options.apiKey ?? env.CHORUS_API_KEY ?? "").trim()
  if (!chorusUrl || !apiKey) {
    throw new Error(
      "CHORUS_URL / CHORUS_API_KEY are not set — finish step 1 (environment variables) and open a NEW terminal, or pass --url and --api-key",
    )
  }

  // Default the plugin spec to the tarball this platform serves: correct by
  // construction on any machine whose step-1 CHORUS_URL points at the platform.
  const spec = options.spec ?? `${chorusUrl}/${ownTarballName()}`
  const initResult = runInit({ ...options, spec, nextHint: false }, io)

  const ManagerCtor = io.manager ? null : await (io.loadManager ?? loadDaemonManager)()
  const manager = io.manager ?? new ManagerCtor({ chorusUrl, apiKey })

  const steps = []
  const record = (step, ok, detail) => {
    steps.push({ step, ok, detail })
    log(`${ok ? "✓" : "✗"} ${step}: ${detail}`)
  }

  const runtime = await manager.ensureRuntime()
  record(
    "install runtime",
    true,
    runtime.updated
      ? `installed daemon ${runtime.to}${runtime.from ? ` (was ${runtime.from})` : ""} at ${runtime.runtimeEntry}`
      : `daemon ${runtime.to} already installed at ${runtime.runtimeEntry}`,
  )

  // Skills engine (non-fatal): OpenCode's skill discovery needs ripgrep, whose
  // built-in installer pulls from GitHub — serve it from the platform instead.
  const ripgrep = await (io.ensureRipgrep ?? ensureRipgrep)(chorusUrl, io)
  log(`${ripgrep.ok ? "✓" : "!"} ripgrep (skills engine): ${ripgrep.detail}`)

  const login = await manager.login(options.workdir)
  const loginOk = login.code === 0
  record(
    "login + unattended defaults",
    loginOk,
    loginOk
      ? `credentials saved; serving directory: ${login.workdir} (wakeConcurrency=1)`
      : `login failed: ${`${login.stdout}${login.stderr}`.trim()}`,
  )
  if (!loginOk) return { ...initResult, ok: false, steps }

  const autostart = await manager.autostart(true)
  record("enable start-at-login", autostart.ok, autostart.detail)

  const start = await manager.ctl("start")
  const startOutput = `${start.stdout}${start.stderr}`.trim()
  // "already running" (pidfile or systemd) is a success — the daemon is up.
  const startOk = start.code === 0 || /already running/i.test(startOutput)
  record("start daemon", startOk, startOutput)

  const status = await manager.ctl("status")
  record("status", status.code === 0, `${status.stdout}${status.stderr}`.trim())

  const ok = steps.every((step) => step.ok)
  log(
    ok
      ? "unattended mode is ACTIVE — this machine now executes platform tasks even with OpenCode closed (local console: http://127.0.0.1:8638)"
      : "setup finished with FAILURES — see the failing step above, fix it, and re-run this same command",
  )
  return { ...initResult, ok, steps, ripgrep }
}

function usage(log = console.log) {
  log("usage: opencode-chorus init  [--spec <plugin-spec>] [--keep-mcp] [--config <path>]")
  log("       opencode-chorus setup [--url <chorus-url>] [--api-key <key>] [--workdir <dir>]")
  log("  init  — merge this plugin into the global OpenCode config (~/.config/opencode/opencode.json)")
  log("  setup — init + install/login/autostart/start the unattended daemon (reads CHORUS_URL / CHORUS_API_KEY)")
}

const invokedDirectly = (() => {
  try {
    // npm/npx expose the bin as a symlink (node_modules/.bin/opencode-chorus),
    // so resolve symlinks before comparing against this module's real path.
    return process.argv[1] ? realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) : false
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === "init") {
    try {
      runInit(args)
    } catch (error) {
      console.error(String(error instanceof Error ? error.message : error))
      process.exit(1)
    }
  } else if (args.command === "setup") {
    runSetup(args).then(
      (result) => process.exit(result.ok ? 0 : 1),
      (error) => {
        console.error(String(error instanceof Error ? error.message : error))
        process.exit(1)
      },
    )
  } else {
    usage()
    process.exit(args.command ? 1 : 0)
  }
}
