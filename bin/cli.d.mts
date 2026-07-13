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
  /** Suppress the trailing "next: …" guidance line (setup passes false). */
  nextHint?: boolean
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

export function ownTarballName(pkg?: { name: string; version: string }): string

export type RunSetupOptions = RunInitOptions & {
  url?: string
  apiKey?: string
  workdir?: string
}

export type SetupManager = {
  ensureRuntime(): Promise<{ updated: boolean; from?: string | null; to: string; runtimeEntry: string }>
  login(workdir?: string): Promise<{ code: number; stdout: string; stderr: string; workdir?: string }>
  autostart(enable: boolean): Promise<{ ok: boolean; detail: string }>
  ctl(action: string): Promise<{ code: number; stdout: string; stderr: string }>
}

export type RunSetupIo = RunInitIo & {
  manager?: SetupManager
  loadManager?: () => Promise<new (opts: { chorusUrl: string; apiKey: string }) => SetupManager>
}

export function runSetup(
  options?: RunSetupOptions,
  io?: RunSetupIo,
): Promise<{
  target: string
  spec: string
  replaced: boolean
  removedMcp: boolean
  ok: boolean
  steps: Array<{ step: string; ok: boolean; detail: string }>
}>
