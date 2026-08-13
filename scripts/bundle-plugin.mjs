// scripts/bundle-plugin.mjs
// Bundle the opencode-loaded plugin entry (dist/index.js) into a SELF-CONTAINED
// file so the shipped package has ZERO runtime npm dependencies. The intranet npm
// mirror 404s on the plugin's deps (@modelcontextprotocol/sdk, @opencode-ai/plugin
// → zod), so neither `npx <tgz> setup` nor opencode's own plugin install may fetch
// anything from npm — the tgz itself comes from the Chorus server, not the mirror.
//
// Mirrors scripts/sync-daemon.mjs's esbuild approach (the daemon is already a
// zero-dep bundle). Run AFTER tsc (see the `prepack` script): tsc still emits the
// .d.ts types and dist/daemon/* (which bin/cli.mjs imports at setup time, all pure
// node builtins), and this step overwrites dist/index.js with a bundle that inlines
// the MCP SDK + @opencode-ai/plugin's `tool` (+ its zod). bin/cli.mjs and the daemon
// bundle do NOT touch those deps, so the whole package resolves with node builtins
// only.
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { existsSync, readFileSync } from "node:fs"

const ESBUILD_VERSION = "0.25.0"
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const entry = path.join(pluginRoot, "dist", "index.js")

if (!existsSync(entry)) {
  throw new Error(`missing ${entry} — run the tsc build (bun run build) before bundling`)
}

// esbuild via `npx -y esbuild@<pinned>` so we don't add it to the plugin's own dep
// tree. --allow-overwrite lets the entry be its own output. Under --platform=node,
// node built-ins stay external automatically; everything else esbuild resolves from
// node_modules and inlines (the build FAILS loudly if a dep can't be resolved).
execFileSync(
  "npx",
  [
    "-y",
    `esbuild@${ESBUILD_VERSION}`,
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    "--allow-overwrite",
    `--outfile=${entry}`,
  ],
  { stdio: "inherit", cwd: pluginRoot },
)

// Guard: the bundle must leave NO third-party import behind — any remaining bare,
// non-builtin specifier is something a consumer would have to npm-install (and the
// mirror would 404 on). Node built-ins (bare or node:-prefixed) are fine.
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
  "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys",
  "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads",
  "zlib",
])
const out = readFileSync(entry, "utf8")
// Only inspect REAL module specifiers, not import-like text inside comments/strings
// (bundled deps carry JSDoc examples like `import { X } from 'ajv'`). esbuild hoists
// genuine external imports to column 0, so anchor to start-of-line; also catch bare
// side-effect imports and dynamic import("…") calls.
const specifiers = [
  ...out.matchAll(/^import\b[^\n]*?\bfrom\s*["']([^"']+)["']/gm),
  ...out.matchAll(/^import\s*["']([^"']+)["']/gm),
  ...out.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
].map((m) => m[1])
const leaked = specifiers.filter((s) => {
  if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/")) return false
  const bare = s.startsWith("node:") ? s.slice(5) : s
  return !NODE_BUILTINS.has(bare.split("/")[0])
})
if (leaked.length) {
  throw new Error(
    `plugin bundle still has external imports (the intranet mirror would 404 on these): ${[...new Set(leaked)].join(", ")}`,
  )
}

console.log(`bundled plugin entry -> dist/index.js (zero runtime deps, ${(out.length / 1024).toFixed(0)} KB)`)
