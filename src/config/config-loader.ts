import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveConfig, type OpenCodeChorusConfig } from "./schema"

export type ChorusConfigEnv = Record<string, string | undefined>

export type ChorusConfigLoadResult = {
  config: OpenCodeChorusConfig
  metadata: {
    apiKeySource?: "chorus.json" | "env" | "options"
    stateModeSource?: ConfigSource
    globalStateRootSource?: ConfigSource
    stateDirSource?: ConfigSource
  }
}

export class InvalidChorusConfigError extends Error {
  readonly configPath: string

  constructor(configPath: string, cause: unknown) {
    super(`Failed to parse Chorus config at ${configPath}: ${formatErrorMessage(cause)}`)
    this.name = "InvalidChorusConfigError"
    this.configPath = configPath
  }
}

type PartialConfig = Record<string, unknown>
type ConfigSource = "chorus.json" | "env" | "options"

const CHORUS_CONFIG_FILE = "chorus.json"

export async function loadChorusConfig(
  explicitOptions: PartialConfig = {},
  env: ChorusConfigEnv = process.env,
): Promise<ChorusConfigLoadResult> {
  const configDir = resolveOpenCodeConfigDir(env)
  const filePath = join(configDir, CHORUS_CONFIG_FILE)
  const fileConfig = await readChorusConfigFile(filePath)
  const envConfig = parseEnvConfig(env)
  const optionsConfig = stripUndefined(explicitOptions)

  const merged = {
    ...fileConfig,
    ...envConfig,
    ...optionsConfig,
  }

  return {
    config: resolveConfig(merged),
    metadata: {
      apiKeySource: resolveApiKeySource(fileConfig, envConfig, optionsConfig),
      stateModeSource: resolveConfigSource("stateMode", fileConfig, envConfig, optionsConfig),
      globalStateRootSource: resolveConfigSource("globalStateRoot", fileConfig, envConfig, optionsConfig),
      stateDirSource: resolveConfigSource("stateDir", fileConfig, envConfig, optionsConfig),
    },
  }
}

export function resolveOpenCodeConfigDir(env: ChorusConfigEnv = process.env): string {
  const explicit = env.OPENCODE_CONFIG_DIR?.trim()
  if (explicit) return expandHome(explicit)

  const xdg = env.XDG_CONFIG_HOME?.trim()
  if (xdg) return join(expandHome(xdg), "opencode")

  return join(homedir(), ".config", "opencode")
}

async function readChorusConfigFile(filePath: string): Promise<PartialConfig> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch (error) {
    if (isNotFoundError(error)) return {}
    throw error
  }

  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    throw new InvalidChorusConfigError(filePath, error)
  }
}

function parseEnvConfig(env: ChorusConfigEnv): PartialConfig {
  return stripUndefined({
    chorusUrl: firstNonEmpty(env.CHORUS_BASE_URL, env.CHORUS_URL),
    apiKey: nonEmpty(env.CHORUS_API_KEY),
    instanceUuid: nonEmpty(env.CHORUS_INSTANCE_UUID),
    projectUuids: parseCsv(env.CHORUS_PROJECT_UUIDS),
    stateMode: parseStateMode(env.CHORUS_STATE_MODE),
    globalStateRoot: nonEmpty(env.CHORUS_GLOBAL_STATE_ROOT),
    stateDir: nonEmpty(env.CHORUS_STATE_DIR),
    sharedStateMode: nonEmpty(env.CHORUS_SHARED_STATE_MODE),
    enableProposalReviewer: parseBoolean(env.CHORUS_ENABLE_PROPOSAL_REVIEWER),
    enableTaskReviewer: parseBoolean(env.CHORUS_ENABLE_TASK_REVIEWER),
    maxProposalReviewRounds: parsePositiveInteger(env.CHORUS_MAX_PROPOSAL_REVIEW_ROUNDS),
    maxTaskReviewRounds: parsePositiveInteger(env.CHORUS_MAX_TASK_REVIEW_ROUNDS),
    reviewerWaitTimeoutMs: parsePositiveInteger(env.CHORUS_REVIEWER_WAIT_TIMEOUT_MS),
    reviewerPollIntervalMs: parsePositiveInteger(env.CHORUS_REVIEWER_POLL_INTERVAL_MS),
    enableSessionContextSummary: parseBoolean(env.CHORUS_ENABLE_SESSION_CONTEXT_SUMMARY),
    enableNotificationHints: parseBoolean(env.CHORUS_ENABLE_NOTIFICATION_HINTS),
    enableSubsessionInjection: parseBoolean(env.CHORUS_ENABLE_SUBSESSION_INJECTION),
    enablePlanAgentGuidance: parseBoolean(env.CHORUS_ENABLE_PLAN_AGENT_GUIDANCE),
    enablePerTurnReminder: parseBoolean(env.CHORUS_ENABLE_PER_TURN_REMINDER),
    reviewGateOutputMode: parseReviewGateOutputMode(env.CHORUS_REVIEW_GATE_OUTPUT_MODE),
  })
}

function resolveConfigSource(
  key: string,
  fileConfig: PartialConfig,
  envConfig: PartialConfig,
  optionsConfig: PartialConfig,
): ConfigSource | undefined {
  if (Object.hasOwn(optionsConfig, key)) return "options"
  if (Object.hasOwn(envConfig, key)) return "env"
  if (Object.hasOwn(fileConfig, key)) return "chorus.json"
}

function resolveApiKeySource(
  fileConfig: PartialConfig,
  envConfig: PartialConfig,
  optionsConfig: PartialConfig,
): ChorusConfigLoadResult["metadata"]["apiKeySource"] {
  if (hasNonEmptyNormalizedApiKey(optionsConfig)) return "options"
  if (hasNonEmptyNormalizedApiKey(envConfig)) return "env"
  if (hasNonEmptyNormalizedApiKey(fileConfig)) return "chorus.json"
}

function hasNonEmptyNormalizedApiKey(config: PartialConfig): boolean {
  return config.apiKey !== null && config.apiKey !== undefined && String(config.apiKey).trim().length > 0
}

function stripUndefined(input: PartialConfig): PartialConfig {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map(nonEmpty).find((value) => value !== undefined)
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function parseCsv(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return items && items.length > 0 ? items : undefined
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "true" || normalized === "1") return true
  if (normalized === "false" || normalized === "0") return false
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parseReviewGateOutputMode(value: string | undefined): "summary" | "detailed" | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "summary" || normalized === "detailed") return normalized
}

function parseStateMode(value: string | undefined): "global" | "project" | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "global" || normalized === "project") return normalized
}

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

function isNotFoundError(error: unknown): boolean {
  const candidate = error as { code?: unknown }
  return error !== null && typeof error === "object" && candidate.code === "ENOENT"
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
