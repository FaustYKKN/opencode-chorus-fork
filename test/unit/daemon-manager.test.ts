import { describe, expect, it } from "bun:test"
import { DaemonManager, type DaemonManagerIo, type RunResult } from "../../src/daemon/daemon-manager"

type FakeIoOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  files?: Record<string, string>
  existingPaths?: string[]
  runResults?: RunResult[]
}

type FakeIo = DaemonManagerIo & {
  writes: Array<{ target: string; content: string; encoding?: string; mode?: number }>
  copies: Array<{ source: string; target: string }>
  mkdirs: string[]
  removed: string[]
  runs: Array<{ command: string; args: string[] }>
}

function fakeIo(options: FakeIoOptions = {}): FakeIo {
  const files = { ...(options.files ?? {}) }
  const existing = new Set(options.existingPaths ?? [])
  const runResults = [...(options.runResults ?? [])]
  const io: FakeIo = {
    platform: options.platform ?? "linux",
    env: options.env ?? {},
    homedir: () => options.home ?? "/home/dev",
    exists: (target) => existing.has(target) || target in files,
    mkdir: async (target) => {
      io.mkdirs.push(target)
      existing.add(target)
    },
    copyFile: async (source, target) => {
      io.copies.push({ source, target })
      files[target] = files[source] ?? ""
    },
    readFile: async (target) => {
      if (!(target in files)) throw new Error(`ENOENT: ${target}`)
      return files[target]!
    },
    writeFile: async (target, content, opts) => {
      io.writes.push({ target, content, encoding: opts?.encoding, mode: opts?.mode })
      files[target] = content
    },
    remove: async (target) => {
      io.removed.push(target)
      delete files[target]
      existing.delete(target)
    },
    runCapture: async (command, args) => {
      io.runs.push({ command, args })
      return runResults.shift() ?? { code: 0, stdout: "", stderr: "" }
    },
    writes: [],
    copies: [],
    mkdirs: [],
    removed: [],
    runs: [],
  }
  return io
}

const PLUGIN_ROOT = "/plugin"
const EMBEDDED_VERSION = JSON.stringify({ daemonVersion: "0.13.1", forkCommit: "abc1234" })

function embeddedFiles(): Record<string, string> {
  return {
    "/plugin/daemon/VERSION.json": EMBEDDED_VERSION,
    "/plugin/daemon/chorus-daemon.mjs": "// bundle",
    "/plugin/daemon/package.json": "{}",
  }
}

function manager(io: DaemonManagerIo, creds?: { chorusUrl?: string; apiKey?: string }) {
  return new DaemonManager({ pluginRoot: PLUGIN_ROOT, io, ...creds })
}

describe("DaemonManager.ensureRuntime", () => {
  it("copies bundle, VERSION and package.json into ~/.chorus/runtime when missing", async () => {
    const io = fakeIo({ files: embeddedFiles() })
    const result = await manager(io).ensureRuntime()

    expect(result.updated).toBe(true)
    expect(result.to).toBe("0.13.1@abc1234")
    expect(io.copies.map((c) => c.target)).toEqual([
      "/home/dev/.chorus/runtime/chorus-daemon.mjs",
      "/home/dev/.chorus/runtime/VERSION.json",
      "/home/dev/.chorus/runtime/package.json",
    ])
  })

  it("skips the copy when the installed version matches, unless forced", async () => {
    const io = fakeIo({
      files: {
        ...embeddedFiles(),
        "/home/dev/.chorus/runtime/VERSION.json": EMBEDDED_VERSION,
        "/home/dev/.chorus/runtime/chorus-daemon.mjs": "// bundle",
      },
    })
    const m = manager(io)

    const skipped = await m.ensureRuntime()
    expect(skipped.updated).toBe(false)
    expect(io.copies.length).toBe(0)

    const forced = await m.ensureRuntime(true)
    expect(forced.updated).toBe(true)
    expect(io.copies.length).toBe(3)
  })

  it("re-installs and reports the previous version when drifted", async () => {
    const io = fakeIo({
      files: {
        ...embeddedFiles(),
        "/home/dev/.chorus/runtime/VERSION.json": JSON.stringify({ daemonVersion: "0.13.0", forkCommit: "old0000" }),
        "/home/dev/.chorus/runtime/chorus-daemon.mjs": "// old bundle",
      },
    })
    const result = await manager(io).ensureRuntime()

    expect(result.updated).toBe(true)
    expect(result.from).toBe("0.13.0@old0000")
    expect(result.to).toBe("0.13.1@abc1234")
  })

  it("throws a broken-package error when the embedded bundle is absent", async () => {
    const io = fakeIo()
    await expect(manager(io).ensureRuntime()).rejects.toThrow(/embedded daemon bundle is missing/)
  })
})

describe("DaemonManager.resolveNode", () => {
  it("prefers node.exe over shims on Windows PATH", () => {
    const io = fakeIo({
      platform: "win32",
      env: { Path: "C:\\tools;D:\\node" },
      existingPaths: ["D:\\node\\node.exe", "D:\\node\\node.cmd"],
    })
    expect(manager(io).resolveNode()).toBe("D:\\node\\node.exe")
  })

  it("honors CHORUS_NODE_PATH and returns null when nothing resolves", () => {
    const withOverride = fakeIo({ env: { CHORUS_NODE_PATH: "/opt/node/bin/node" }, existingPaths: ["/opt/node/bin/node"] })
    expect(manager(withOverride).resolveNode()).toBe("/opt/node/bin/node")

    const empty = fakeIo({ env: { PATH: "/usr/bin" } })
    expect(manager(empty).resolveNode()).toBeNull()
  })
})

describe("DaemonManager.login", () => {
  it("runs the bundled login verb, then applies wakeConcurrency=4 and a default served dir", async () => {
    const io = fakeIo({
      files: {
        ...embeddedFiles(),
        "/home/dev/.chorus/daemon.json": JSON.stringify({ url: "http://x", apiKey: "cho_k" }),
      },
      existingPaths: ["/usr/bin/node"],
      env: { PATH: "/usr/bin" },
    })
    const result = await manager(io, { chorusUrl: "http://x", apiKey: "cho_k" }).login()

    expect(io.runs[0]).toEqual({
      command: "/usr/bin/node",
      args: ["/home/dev/.chorus/runtime/chorus-daemon.mjs", "login", "--url", "http://x", "--api-key", "cho_k"],
    })
    expect(result.workdir).toBe("/home/dev/opencode-auto-work")
    expect(io.mkdirs).toContain("/home/dev/opencode-auto-work")

    const saved = JSON.parse(io.writes.at(-1)!.content)
    expect(saved.wakeConcurrency).toBe(4)
    expect(saved.cwds).toEqual(["/home/dev/opencode-auto-work"])
    expect(io.writes.at(-1)!.mode).toBe(0o600)
  })

  it("keeps an existing whitelist, appends an explicit workdir, and preserves other keys", async () => {
    const io = fakeIo({
      files: {
        ...embeddedFiles(),
        "/home/dev/.chorus/daemon.json": JSON.stringify({ url: "http://x", apiKey: "cho_k", cwds: ["/srv/a"], wakeConcurrency: 4 }),
      },
      existingPaths: ["/usr/bin/node"],
      env: { PATH: "/usr/bin" },
    })
    const result = await manager(io, { chorusUrl: "http://x", apiKey: "cho_k" }).login("/srv/b")

    expect(result.workdir).toBe("/srv/b")
    const saved = JSON.parse(io.writes.at(-1)!.content)
    expect(saved.cwds).toEqual(["/srv/a", "/srv/b"])
    expect(saved.wakeConcurrency).toBe(4)
    expect(saved.url).toBe("http://x")
  })

  it("surfaces a failed login without touching daemon.json", async () => {
    const io = fakeIo({
      files: embeddedFiles(),
      existingPaths: ["/usr/bin/node"],
      env: { PATH: "/usr/bin" },
      runResults: [{ code: 1, stdout: "", stderr: "Login failed: API key not found" }],
    })
    const result = await manager(io, { chorusUrl: "http://x", apiKey: "cho_bad" }).login()

    expect(result.code).toBe(1)
    expect(io.writes.length).toBe(0)
  })

  it("refuses to run without plugin credentials", async () => {
    const io = fakeIo({ files: embeddedFiles(), existingPaths: ["/usr/bin/node"], env: { PATH: "/usr/bin" } })
    await expect(manager(io).login()).rejects.toThrow(/credentials are not configured/)
  })

  it("picks D:\\opencode-auto-work as the Windows default when D: exists", () => {
    const io = fakeIo({ platform: "win32", existingPaths: ["D:\\"] })
    expect(manager(io).defaultWorkdir()).toBe("D:\\opencode-auto-work")
  })
})

describe("DaemonManager.ctl", () => {
  it("maps start to a detached opencode-backend launch and other verbs to lifecycle actions", async () => {
    const io = fakeIo({ files: embeddedFiles(), existingPaths: ["/usr/bin/node"], env: { PATH: "/usr/bin" } })
    const m = manager(io)

    await m.ctl("start")
    await m.ctl("status")

    expect(io.runs[0]!.args).toEqual(["/home/dev/.chorus/runtime/chorus-daemon.mjs", "daemon", "-d", "--agent", "opencode", "--yolo"])
    expect(io.runs[1]!.args).toEqual(["/home/dev/.chorus/runtime/chorus-daemon.mjs", "daemon", "status"])
  })

  it("throws a clear error when node is unavailable", async () => {
    const io = fakeIo({ files: embeddedFiles(), env: {} })
    await expect(manager(io).ctl("status")).rejects.toThrow(/Node\.js 20\+ was not found/)
  })
})

describe("DaemonManager.autostart", () => {
  it("writes a hidden-window UTF-16 vbs into the Windows Startup folder", async () => {
    const io = fakeIo({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
      files: embeddedFiles(),
      home: "C:\\Users\\dev",
    })
    const result = await manager(io).autostart(true)

    expect(result.ok).toBe(true)
    const write = io.writes.at(-1)!
    expect(write.target).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\chorus-daemon-autostart.vbs",
    )
    expect(write.encoding).toBe("utf16le")
    expect(write.content.startsWith("﻿")).toBe(true)
    expect(write.content).toContain('.Run "cmd /c node ""')
    expect(write.content).toContain('daemon -d --agent opencode --yolo", 0, False')
  })

  it("removes the vbs on disable", async () => {
    const io = fakeIo({ platform: "win32", env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" } })
    const result = await manager(io).autostart(false)

    expect(result.ok).toBe(true)
    expect(io.removed[0]).toContain("chorus-daemon-autostart.vbs")
  })

  it("delegates to the daemon CLI's install/uninstall elsewhere", async () => {
    const io = fakeIo({
      files: embeddedFiles(),
      existingPaths: ["/usr/bin/node"],
      env: { PATH: "/usr/bin" },
      runResults: [{ code: 0, stdout: "installed and started the daemon service", stderr: "" }],
    })
    const result = await manager(io).autostart(true)

    expect(result.ok).toBe(true)
    expect(io.runs[0]!.args).toEqual([
      "/home/dev/.chorus/runtime/chorus-daemon.mjs",
      "daemon",
      "install",
      "--agent",
      "opencode",
      "--yolo",
    ])
    expect(result.detail).toContain("installed and started")
  })
})
