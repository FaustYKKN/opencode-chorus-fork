import {
  DEFAULT_ENABLE_NOTIFICATION_HINTS,
  DEFAULT_ENABLE_PER_TURN_REMINDER,
  DEFAULT_ENABLE_PLAN_AGENT_GUIDANCE,
  DEFAULT_ENABLE_PROPOSAL_REVIEWER,
  DEFAULT_ENABLE_SUBSESSION_INJECTION,
  DEFAULT_ENABLE_SESSION_CONTEXT_SUMMARY,
  DEFAULT_ENABLE_TASK_REVIEWER,
  DEFAULT_MAX_PROPOSAL_REVIEW_ROUNDS,
  DEFAULT_MAX_TASK_REVIEW_ROUNDS,
  DEFAULT_REVIEW_GATE_OUTPUT_MODE,
  DEFAULT_REVIEWER_POLL_INTERVAL_MS,
  DEFAULT_REVIEWER_WAIT_TIMEOUT_MS,
  DEFAULT_SHARED_STATE_MODE,
  DEFAULT_STATE_DIR,
  DEFAULT_STATE_MODE,
} from "./defaults"

export type SharedStateMode = "compatible" | "isolated"
export type ReviewGateOutputMode = "summary" | "detailed"
export type StateMode = "global" | "project"

export type OpenCodeChorusConfig = {
  chorusUrl: string
  apiKey: string
  /** AgentInstance uuid injected by the daemon for woken sessions (CHORUS_INSTANCE_UUID). */
  instanceUuid?: string
  projectUuids: string[]
  enableProposalReviewer: boolean
  enableTaskReviewer: boolean
  maxProposalReviewRounds: number
  maxTaskReviewRounds: number
  reviewerWaitTimeoutMs: number
  reviewerPollIntervalMs: number
  enableSessionContextSummary: boolean
  enableNotificationHints: boolean
  enableSubsessionInjection: boolean
  enablePlanAgentGuidance: boolean
  enablePerTurnReminder: boolean
  reviewGateOutputMode: ReviewGateOutputMode
  stateMode: StateMode
  globalStateRoot?: string
  stateDir: string
  sharedStateMode: SharedStateMode
}

export class MissingRequiredConfigError extends Error {
  readonly configKey: keyof Pick<OpenCodeChorusConfig, "chorusUrl" | "apiKey">

  constructor(configKey: keyof Pick<OpenCodeChorusConfig, "chorusUrl" | "apiKey">) {
    super(`Missing required config: ${configKey}`)
    this.name = "MissingRequiredConfigError"
    this.configKey = configKey
  }
}

export function resolveConfig(input: Record<string, unknown>): OpenCodeChorusConfig {
  const chorusUrl = String(input.chorusUrl ?? "").trim()
  const apiKey = String(input.apiKey ?? "").trim()

  if (!chorusUrl) throw new MissingRequiredConfigError("chorusUrl")
  if (!apiKey) throw new MissingRequiredConfigError("apiKey")

  const instanceUuid = String(input.instanceUuid ?? "").trim()

  return {
    chorusUrl,
    apiKey,
    instanceUuid: instanceUuid || undefined,
    projectUuids: Array.isArray(input.projectUuids)
      ? input.projectUuids.map((item) => String(item))
      : [],
    enableProposalReviewer:
      input.enableProposalReviewer === undefined
        ? DEFAULT_ENABLE_PROPOSAL_REVIEWER
        : Boolean(input.enableProposalReviewer),
    enableTaskReviewer:
      input.enableTaskReviewer === undefined
        ? DEFAULT_ENABLE_TASK_REVIEWER
        : Boolean(input.enableTaskReviewer),
    maxProposalReviewRounds:
      typeof input.maxProposalReviewRounds === "number"
        ? input.maxProposalReviewRounds
        : DEFAULT_MAX_PROPOSAL_REVIEW_ROUNDS,
    maxTaskReviewRounds:
      typeof input.maxTaskReviewRounds === "number"
        ? input.maxTaskReviewRounds
        : DEFAULT_MAX_TASK_REVIEW_ROUNDS,
    reviewerWaitTimeoutMs: resolvePositiveInteger(
      input.reviewerWaitTimeoutMs,
      DEFAULT_REVIEWER_WAIT_TIMEOUT_MS,
    ),
    reviewerPollIntervalMs: resolvePositiveInteger(
      input.reviewerPollIntervalMs,
      DEFAULT_REVIEWER_POLL_INTERVAL_MS,
    ),
    enableSessionContextSummary:
      input.enableSessionContextSummary === undefined
        ? DEFAULT_ENABLE_SESSION_CONTEXT_SUMMARY
        : Boolean(input.enableSessionContextSummary),
    enableNotificationHints:
      input.enableNotificationHints === undefined
        ? DEFAULT_ENABLE_NOTIFICATION_HINTS
        : Boolean(input.enableNotificationHints),
    enableSubsessionInjection:
      input.enableSubsessionInjection === undefined
        ? DEFAULT_ENABLE_SUBSESSION_INJECTION
        : Boolean(input.enableSubsessionInjection),
    enablePlanAgentGuidance:
      input.enablePlanAgentGuidance === undefined
        ? DEFAULT_ENABLE_PLAN_AGENT_GUIDANCE
        : Boolean(input.enablePlanAgentGuidance),
    enablePerTurnReminder:
      input.enablePerTurnReminder === undefined
        ? DEFAULT_ENABLE_PER_TURN_REMINDER
        : Boolean(input.enablePerTurnReminder),
    reviewGateOutputMode:
      input.reviewGateOutputMode === "detailed" ? "detailed" : DEFAULT_REVIEW_GATE_OUTPUT_MODE,
    stateMode: input.stateMode === "project" ? "project" : DEFAULT_STATE_MODE,
    ...(optionalString(input.globalStateRoot) ? { globalStateRoot: optionalString(input.globalStateRoot) } : {}),
    stateDir: String(input.stateDir ?? DEFAULT_STATE_DIR),
    sharedStateMode:
      input.sharedStateMode === "isolated" ? "isolated" : DEFAULT_SHARED_STATE_MODE,
  }
}

function optionalString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined
  return trimmed ? trimmed : undefined
}

function resolvePositiveInteger(value: unknown, defaultValue: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : defaultValue
}
