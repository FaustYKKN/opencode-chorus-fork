import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

const readJson = async <T>(path: string): Promise<T> => {
  const file = await readFile(new URL(path, import.meta.url), "utf8")
  return JSON.parse(file) as T
}

describe("package manifest", () => {
  it("matches the npm packaging contract", async () => {
    const packageJson = await readJson<Record<string, unknown>>("../../package.json")
    const buildTsconfig = await readJson<{
      extends?: string
      compilerOptions?: Record<string, unknown>
      include?: unknown
    }>("../../tsconfig.build.json")

    expect(packageJson).toMatchObject({
      name: "opencode-chorus",
      description: "OpenCode plugin for Chorus MCP workflow, planning, and reviewer automation.",
      license: "AGPL-3.0-only",
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      author: "etnperlong",
      repository: {
        type: "git",
        url: "git+https://github.com/etnperlong/opencode-chorus.git"
      },
      homepage: "https://github.com/etnperlong/opencode-chorus#readme",
      bugs: {
        url: "https://github.com/etnperlong/opencode-chorus/issues"
      },
      engines: {
        opencode: ">=1.14.28 <2",
        bun: ">=1.1.0 <2"
      },
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js"
        },
        "./server": "./dist/index.js"
      },
      files: ["dist", "daemon", "skills", "prompts", "README.md", "LICENSE"],
      scripts: {
        clean: "node ./scripts/clean-dist.mjs",
        build: "tsc -p tsconfig.build.json",
        typecheck: "tsc --noEmit",
        test: "bun test",
        "pack:check": "npm pack --dry-run",
        "sync:daemon": "node ./scripts/sync-daemon.mjs",
        prepack: "bun run clean && bun run build",
        prepublishOnly: "bun run typecheck && bun run test && bun run pack:check"
      },
      devDependencies: {
        typescript: "^6.0.3"
      }
    })

    expect(packageJson.module).toBeUndefined()
    expect(packageJson.private).toBeUndefined()
    expect((packageJson.peerDependencies as Record<string, unknown> | undefined)?.typescript).toBeUndefined()

    expect(buildTsconfig).toMatchObject({
      extends: "./tsconfig.json",
      compilerOptions: {
        noEmit: false,
        allowImportingTsExtensions: false,
        rootDir: "./src",
        outDir: "./dist",
        declaration: true,
        declarationMap: false,
        sourceMap: false
      },
      include: ["src/**/*.ts"]
    })
    expect(buildTsconfig.compilerOptions?.types).toEqual(["bun"])
  })
})
