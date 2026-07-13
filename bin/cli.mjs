#!/usr/bin/env node
// bin/cli.mjs — opencode-chorus command line.
//
//   opencode-chorus init [--spec <plugin-spec>] [--keep-mcp] [--config <path>]
//
// `init` merges this plugin into the user's global OpenCode config so
// onboarding never requires hand-editing JSON: it adds (or replaces) the
// plugin entry and, by default, removes a native `mcp.chorus` block pointing
// at a Chorus `/api/mcp` endpoint — the plugin provides the same bridge, and
// running both channels registers confusing duplicate tools.
//
// Zero dependencies (node builtins only) so `npx <package> init` works before
// anything else is installed. Pure helpers are exported for tests.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
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

function ownSpec() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  return `${pkg.name}@${pkg.version}`
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
  log('next: open OpenCode and ask the agent to run chorus_daemon with action "setup" to enable unattended mode')
  return { target, spec, replaced: merged.replaced, removedMcp }
}

function usage(log = console.log) {
  log("usage: opencode-chorus init [--spec <plugin-spec>] [--keep-mcp] [--config <path>]")
  log("  merges this plugin into the global OpenCode config (~/.config/opencode/opencode.json)")
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
  } else {
    usage()
    process.exit(args.command ? 1 : 0)
  }
}
