import { describe, expect, it } from "bun:test"
import { isThisPlugin, mergePluginEntry, resolveConfigPath, runInit, stripNativeChorusMcp } from "../../bin/cli.mjs"

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
