import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, sep } from "node:path"

// Resolve bundled resources (skills/, prompts/) relative to the PACKAGE ROOT — the
// nearest ancestor directory that contains package.json — discovered by walking up
// from this module's own location.
//
// Why not a hardcoded `../../skills`: that is only correct for ONE module depth. This
// file's tsc output lives at dist/util/package-resource-paths.js (root is two up),
// but after esbuild bundles the plugin entry it is inlined into dist/index.js (root
// is ONE up). A fixed `../../` then overshoots into node_modules/ and the prompts /
// skills reads fail with ENOENT. Finding package.json is robust to both layouts.
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dir
}

const PACKAGE_ROOT = findPackageRoot()

// Trailing separator kept to match the prior (URL-derived) value byte-for-byte.
export const bundledSkillsDir = join(PACKAGE_ROOT, "skills") + sep

export function getBundledPromptPath(name: string): string {
  return join(PACKAGE_ROOT, "prompts", name)
}

export function readBundledPrompt(name: string): Promise<string> {
  return readFile(getBundledPromptPath(name), "utf8")
}
