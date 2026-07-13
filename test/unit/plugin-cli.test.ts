import { describe, expect, it } from "bun:test"
import {
  ensureRipgrep,
  isThisPlugin,
  mergePluginEntry,
  mergeSkillsPath,
  ownTarballName,
  resolveConfigPath,
  runInit,
  runSetup,
  stableSkillsDir,
  stripNativeChorusMcp,
} from "../../bin/cli.mjs"

describe("cli init helpers", () => {
  it("recognizes this plugin in every spec shape", () => {
    for (const entry of [
      "opencode-chorus",
      "opencode-chorus@0.10.0",
      "@tixiao/opencode-chorus",
      "@tixiao/opencode-chorus@1.2.3",
      "file:///C:/chorus/opencode-chorus-0.10.0.tgz",
      "http://10.0.4.14:8637/opencode-chorus-0.10.0.tgz",
      "https://chorus.internal/opencode-chorus-0.11.0.tgz",
    ]) {
      expect(isThisPlugin(entry)).toBe(true)
    }
    for (const entry of ["opencode-other", "@scope/opencode-chorus-extras", 42]) {
      expect(isThisPlugin(entry as never)).toBe(false)
    }
  })

  it("appends the entry and replaces any previous form of this plugin", () => {
    const added = mergePluginEntry({}, "@tixiao/opencode-chorus@0.11.0")
    expect(added.config.plugin).toEqual(["@tixiao/opencode-chorus@0.11.0"])
    expect(added.replaced).toBe(false)

    const replaced = mergePluginEntry(
      { plugin: ["other-plugin", "opencode-chorus"] },
      "@tixiao/opencode-chorus@0.11.0",
    )
    expect(replaced.config.plugin).toEqual(["other-plugin", "@tixiao/opencode-chorus@0.11.0"])
    expect(replaced.replaced).toBe(true)
  })

  it("removes only a chorus mcp block that targets /api/mcp", () => {
    const ours = stripNativeChorusMcp({
      mcp: { chorus: { type: "remote", url: "http://10.0.4.14:8637/api/mcp" }, other: { url: "http://x" } },
    })
    expect(ours.removed).toBe(true)
    expect(ours.config.mcp).toEqual({ other: { url: "http://x" } })

    const lastEntry = stripNativeChorusMcp({ mcp: { chorus: { url: "http://h/api/mcp" } } })
    expect(lastEntry.removed).toBe(true)
    expect("mcp" in lastEntry.config).toBe(false)

    const foreign = stripNativeChorusMcp({ mcp: { chorus: { url: "http://elsewhere/other" } } })
    expect(foreign.removed).toBe(false)
  })

  it("resolves OPENCODE_CONFIG over the default global path", () => {
    expect(resolveConfigPath({ OPENCODE_CONFIG: "/custom/oc.json" }, "/home/dev")).toBe("/custom/oc.json")
    expect(resolveConfigPath({}, "/home/dev")).toContain("/home/dev")
  })
})

describe("cli runInit", () => {
  function fakeFs(initial?: string) {
    const files: Record<string, string> = {}
    if (initial !== undefined) files["/home/dev/.config/opencode/opencode.json"] = initial
    return {
      files,
      io: {
        env: {},
        home: "/home/dev",
        existsSync: (p: string) => p in files,
        readFileSync: (p: string) => files[p]!,
        writeFileSync: (p: string, content: string) => {
          files[p] = content
        },
        mkdirSync: () => {},
        log: () => {},
      },
    }
  }

  it("merges into an existing config, preserving model settings and stripping our mcp block", () => {
    const existing = JSON.stringify({
      provider: { deepseek: { options: { apiKey: "sk-x" } } },
      model: "deepseek/deepseek-v4-pro",
      mcp: { chorus: { type: "remote", url: "http://10.0.4.14:8637/api/mcp" } },
    })
    const { files, io } = fakeFs(existing)

    const result = runInit({ spec: "@tixiao/opencode-chorus@0.11.0" }, io)

    expect(result.removedMcp).toBe(true)
    const saved = JSON.parse(files["/home/dev/.config/opencode/opencode.json"]!)
    expect(saved.model).toBe("deepseek/deepseek-v4-pro")
    expect(saved.provider.deepseek.options.apiKey).toBe("sk-x")
    expect(saved.plugin).toEqual(["@tixiao/opencode-chorus@0.11.0"])
    expect("mcp" in saved).toBe(false)
  })

  it("creates a fresh config with $schema when none exists", () => {
    const { files, io } = fakeFs()

    runInit({ spec: "opencode-chorus@0.10.0" }, io)

    const saved = JSON.parse(files["/home/dev/.config/opencode/opencode.json"]!)
    expect(saved.$schema).toBe("https://opencode.ai/config.json")
    expect(saved.plugin).toEqual(["opencode-chorus@0.10.0"])
  })

  it("keeps the mcp block when --keep-mcp is set and fails loudly on corrupt JSON", () => {
    const { files, io } = fakeFs(JSON.stringify({ mcp: { chorus: { url: "http://h/api/mcp" } } }))
    runInit({ spec: "opencode-chorus@0.10.0", keepMcp: true }, io)
    expect(JSON.parse(files["/home/dev/.config/opencode/opencode.json"]!).mcp.chorus.url).toBe("http://h/api/mcp")

    const corrupt = fakeFs("{oops")
    expect(() => runInit({ spec: "x" }, corrupt.io)).toThrow(/not valid JSON/)
  })
})

describe("cli mergeSkillsPath", () => {
  it("adds the stable dir, idempotently", () => {
    const first = mergeSkillsPath({}, "/home/dev/.chorus/skills")
    expect(first.config.skills).toEqual({ paths: ["/home/dev/.chorus/skills"] })
    expect(first.added).toBe(true)

    const again = mergeSkillsPath(first.config, "/home/dev/.chorus/skills/")
    expect((again.config.skills as { paths: string[] }).paths).toHaveLength(1)
    expect(again.added).toBe(false)
  })

  it("removes stale entries pointing into the plugin cache, keeps foreign ones", () => {
    const result = mergeSkillsPath(
      {
        skills: {
          paths: [
            "C:\\Users\\lingy\\.cache\\opencode\\packages\\http_\\42.192.227.134_8637\\opencode-chorus-0.10.0.tgz\\node_modules\\opencode-chorus\\skills",
            "/home/dev/my-own-skills",
          ],
        },
      },
      "C:\\Users\\lingy\\.chorus\\skills",
    )
    expect(result.removedStale).toBe(true)
    expect((result.config.skills as { paths: string[] }).paths).toEqual([
      "/home/dev/my-own-skills",
      "C:\\Users\\lingy\\.chorus\\skills",
    ])
  })

  it("never touches a developer checkout whose path merely contains opencode-chorus", () => {
    const result = mergeSkillsPath(
      { skills: { paths: ["D:\\work\\opencode-chorus\\skills", "/home/dev/tixiao/opencode-chorus/skills"] } },
      "/home/dev/.chorus/skills",
    )
    expect(result.removedStale).toBe(false)
    expect((result.config.skills as { paths: string[] }).paths).toEqual([
      "D:\\work\\opencode-chorus\\skills",
      "/home/dev/tixiao/opencode-chorus/skills",
      "/home/dev/.chorus/skills",
    ])
  })
})

describe("cli runSetup", () => {
  function fakeManager(over: Record<string, unknown> = {}) {
    const calls: string[] = []
    return {
      calls,
      manager: {
        ensureRuntime: async () => {
          calls.push("ensureRuntime")
          return { updated: true, from: null, to: "0.13.1", runtimeEntry: "/home/dev/.chorus/runtime/chorus-daemon.mjs" }
        },
        login: async () => {
          calls.push("login")
          return { code: 0, stdout: "", stderr: "", workdir: "/home/dev/opencode-auto-work" }
        },
        autostart: async () => {
          calls.push("autostart")
          return { ok: true, detail: "systemd unit enabled" }
        },
        ctl: async (action: string) => {
          calls.push(`ctl:${action}`)
          return { code: 0, stdout: `${action} ok`, stderr: "" }
        },
        ...over,
      },
    }
  }

  function setupIo(manager: import("../../bin/cli.mjs").SetupManager, env: Record<string, string>) {
    const files: Record<string, string> = {}
    return {
      files,
      io: {
        env,
        home: "/home/dev",
        existsSync: (p: string) => p in files,
        readFileSync: (p: string) => files[p]!,
        writeFileSync: (p: string, content: string) => {
          files[p] = content
        },
        mkdirSync: () => {},
        log: () => {},
        manager,
        ensureRipgrep: async () => ({ ok: true, installed: false, detail: "stubbed" }),
        cpSync: undefined as ((from: string, to: string) => void) | undefined,
      },
    }
  }

  it("throws without credentials, listing what step 1 should have provided", async () => {
    const { io } = setupIo(fakeManager().manager, {})
    await expect(runSetup({}, io)).rejects.toThrow(/CHORUS_URL \/ CHORUS_API_KEY/)
  })

  it("runs init with a platform-derived spec, then the full daemon chain in order", async () => {
    const { calls, manager } = fakeManager()
    const { files, io } = setupIo(manager, { CHORUS_URL: "http://10.0.4.14:8637/", CHORUS_API_KEY: "cho_k" })

    const result = await runSetup({}, io)

    expect(result.ok).toBe(true)
    const saved = JSON.parse(files["/home/dev/.config/opencode/opencode.json"]!)
    expect(saved.plugin).toEqual([`http://10.0.4.14:8637/${ownTarballName()}`])
    expect(calls).toEqual(["ensureRuntime", "login", "autostart", "ctl:start", "ctl:status"])
    expect(result.steps.map((s) => s.ok)).toEqual([true, true, true, true, true])
  })

  it("copies skills to the stable dir and pins skills.paths at the file level", async () => {
    const { manager } = fakeManager()
    const copies: Array<[string, string]> = []
    const { files, io } = setupIo(manager, { CHORUS_URL: "http://h", CHORUS_API_KEY: "cho_k" })
    io.existsSync = (p: string) => p in files || p.endsWith("skills") || p.endsWith(`skills${sep(p)}`)
    io.cpSync = (from: string, to: string) => {
      copies.push([from, to])
    }
    function sep(p: string) {
      return p.includes("\\") ? "\\" : "/"
    }

    const result = await runSetup({}, io)

    expect(copies).toHaveLength(1)
    expect(copies[0]![1]).toBe(stableSkillsDir("/home/dev"))
    const saved = JSON.parse(files["/home/dev/.config/opencode/opencode.json"]!)
    expect(saved.skills.paths).toEqual([stableSkillsDir("/home/dev")])
    expect(result.skillsPathAdded).toBe(true)
  })

  it("treats an 'already running under systemd' start refusal as success", async () => {
    const { manager } = fakeManager({
      ctl: async (action: string) =>
        action === "start"
          ? { code: 1, stdout: "", stderr: "a daemon is already running under systemd (chorus-daemon.service)." }
          : { code: 0, stdout: "active", stderr: "" },
    })
    const { io } = setupIo(manager, { CHORUS_URL: "http://h", CHORUS_API_KEY: "cho_k" })

    const result = await runSetup({}, io)
    expect(result.ok).toBe(true)
  })

  it("stops after a failed login and reports ok=false", async () => {
    const { calls, manager } = fakeManager()
    manager.login = async () => {
      calls.push("login")
      return { code: 1, stdout: "", stderr: "API key not found", workdir: "" }
    }
    const { io } = setupIo(manager, { CHORUS_URL: "http://h", CHORUS_API_KEY: "cho_bad" })

    const result = await runSetup({}, io)
    expect(result.ok).toBe(false)
    expect(calls).toEqual(["ensureRuntime", "login"])
  })

  it("flattens a scoped package name into npm pack's tarball filename", () => {
    expect(ownTarballName({ name: "opencode-chorus", version: "0.10.0" })).toBe("opencode-chorus-0.10.0.tgz")
    expect(ownTarballName({ name: "@tixiao/opencode-chorus", version: "0.11.0" })).toBe(
      "tixiao-opencode-chorus-0.11.0.tgz",
    )
  })
})

describe("cli ensureRipgrep", () => {
  it("short-circuits when rg is already in opencode's bin dir or on PATH", async () => {
    const inBin = await ensureRipgrep("http://h", {
      platform: "win32",
      home: "C:\\Users\\dev",
      existsSync: () => true,
      whichRg: () => false,
    })
    expect(inBin).toMatchObject({ ok: true, installed: false })

    const onPath = await ensureRipgrep("http://h", {
      platform: "linux",
      home: "/home/dev",
      existsSync: () => false,
      whichRg: () => true,
    })
    expect(onPath).toMatchObject({ ok: true, installed: false })
  })

  it("downloads the platform archive and extracts when missing", async () => {
    const fetched: string[] = []
    const extracted: Buffer[] = []
    const result = await ensureRipgrep("http://10.0.4.14:8637", {
      platform: "win32",
      home: "C:\\Users\\dev",
      existsSync: () => false,
      whichRg: () => false,
      download: async (url: string) => {
        fetched.push(url)
        return Buffer.from("zip-bytes")
      },
      extract: (archive: Buffer) => {
        extracted.push(archive)
      },
    })
    expect(result.ok).toBe(true)
    expect(result.installed).toBe(true)
    expect(fetched).toEqual(["http://10.0.4.14:8637/ripgrep-win64.zip"])
    expect(extracted).toHaveLength(1)
  })

  it("reports failure without throwing when the download fails", async () => {
    const result = await ensureRipgrep("http://h", {
      platform: "win32",
      home: "C:\\Users\\dev",
      existsSync: () => false,
      whichRg: () => false,
      download: async () => {
        throw new Error("HTTP 404")
      },
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/HTTP 404/)
    expect(result.detail).toMatch(/manually/)
  })
})
