// Type surface of bin/cli.mjs (kept as plain zero-dependency JS so
// `node bin/cli.mjs init` works on an unpacked tarball without a build step).

export function resolveConfigPath(env?: NodeJS.ProcessEnv, home?: string): string

export function isThisPlugin(entry: unknown): boolean

export function mergePluginEntry(
  config: Record<string, unknown>,
  spec: string,
): { config: Record<string, unknown> & { plugin: unknown[] }; replaced: boolean }

export function stripNativeChorusMcp(config: Record<string, unknown>): {
  config: Record<string, unknown>
  removed: boolean
}

export type RunInitOptions = {
  spec?: string
  configPath?: string
  keepMcp?: boolean
}

export type RunInitIo = {
  env?: NodeJS.ProcessEnv
  home?: string
  existsSync?: (target: string) => boolean
  readFileSync?: (target: string, encoding: string) => string
  writeFileSync?: (target: string, content: string) => void
  mkdirSync?: (target: string) => void
  log?: (message: string) => void
}

export function runInit(
  options?: RunInitOptions,
  io?: RunInitIo,
): { target: string; spec: string; replaced: boolean; removedMcp: boolean }
