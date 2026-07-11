// scripts/sync-daemon.mjs
// Bundle the Chorus daemon (from our chorus fork checkout) into a single
// self-contained ESM file vendored at daemon/chorus-daemon.mjs, so the plugin
// package can install and run the daemon on machines that only have Node —
// no npm install, no node_modules, no separate download.
//
// Usage:
//   node ./scripts/sync-daemon.mjs [fork-dir]
//   CHORUS_FORK_DIR=/path/to/chorus-fork node ./scripts/sync-daemon.mjs
//
// The fork dir defaults to ../chorus-upstream (sibling checkout). esbuild is
// invoked via `npx -y esbuild@<pinned>` so the plugin's own dependency tree
// stays untouched. Re-run after every daemon-side change, then commit the
// regenerated daemon/ artifacts.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ESBUILD_VERSION = "0.25.0"

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, "..")
const forkDir = path.resolve(process.argv[2] ?? process.env.CHORUS_FORK_DIR ?? path.join(pluginRoot, "..", "chorus-upstream"))
const entry = path.join(forkDir, "chorus.mjs")
const outDir = path.join(pluginRoot, "daemon")
const outFile = path.join(outDir, "chorus-daemon.mjs")

if (!existsSync(entry)) {
  console.error(`chorus fork entry not found: ${entry}`)
  console.error("pass the fork checkout as argv[1] or CHORUS_FORK_DIR")
  process.exit(1)
}

const forkPkg = JSON.parse(readFileSync(path.join(forkDir, "package.json"), "utf8"))
let forkCommit = "unknown"
try {
  forkCommit = execFileSync("git", ["-C", forkDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()
} catch {
  // not a git checkout — VERSION still records the package version
}

mkdirSync(outDir, { recursive: true })

// Bundle. The fork's cli is plain ESM; its one real dependency
// (@modelcontextprotocol/sdk) gets inlined. The server-launch branch does a
// runtime-computed dynamic import (.next standalone server.js) that esbuild
// cannot resolve statically — that branch is unreachable for daemon/login
// usage, so the unresolved-import warning is expected and harmless.
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
    "--legal-comments=none",
    `--outfile=${outFile}`,
    // Node built-ins stay external automatically under platform=node.
    "--log-override:unsupported-dynamic-import=silent",
    // ESM output of CJS deps needs a require shim.
    "--banner:js=import { createRequire as __chorusCreateRequire } from 'node:module'; const require = __chorusCreateRequire(import.meta.url);",
  ],
  { stdio: ["ignore", "inherit", "inherit"], cwd: pluginRoot },
)

const version = {
  daemonVersion: forkPkg.version,
  forkCommit,
  bundledAt: new Date().toISOString(),
  esbuild: ESBUILD_VERSION,
}
writeFileSync(path.join(outDir, "VERSION.json"), JSON.stringify(version, null, 2) + "\n")

// The CLI reads ./package.json next to its entry for the version banner — give
// the bundle a minimal one (also pins ESM semantics for the directory).
writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify({ name: forkPkg.name, version: forkPkg.version, type: "module", private: true }, null, 2) + "\n",
)

// Smoke: the bundle must run standalone (help path) with plain node.
execFileSync(process.execPath, [outFile, "daemon", "--help"], { stdio: "ignore" })
console.log(`bundled ${forkPkg.version}@${forkCommit} -> ${path.relative(pluginRoot, outFile)}`)
console.log("smoke ok: `daemon --help` runs standalone")
