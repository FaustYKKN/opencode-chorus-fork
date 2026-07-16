// Injects concise Chorus runtime context and workflow reminders.

import { formatPermissions } from "../lifecycle/chorus-readiness"
import { isOpenSpecCliAvailable } from "../openspec/cli"
import { detectOpenSpecAvailability } from "../openspec/detect"
import type { SessionContextRecord } from "../state/state-types"
import { formatStagingDirSystemGuidance } from "../util/staging-guidance"

export const PER_TURN_REMINDER =
  "[Chorus Plugin Active]\n- Sub-agent sessions are auto-managed by hooks. Do NOT call chorus_create_session or chorus_close_session for sub-agents.\n- When spawning sub-agents, pass Chorus task UUIDs; session lifecycle is auto-injected."

// Always-on process-safety guardrail. The Chorus daemon that dispatches tasks is
// a Node.js process; the agent itself runs in Bun. So a name-based Node kill —
// a routine "clean up stuck processes" / "restart the dev server" move — takes
// out the daemon (and any Node dev servers) WITHOUT touching the agent, cutting
// the unattended run dead mid-task. On Windows the Startup-folder autostart never
// brings it back. Names the exact forbidden commands cross-platform so even a
// weak model can pattern-match them.
export const PROCESS_SAFETY_GUARDRAIL =
  "[Chorus Safety] The Chorus daemon that dispatches your tasks runs as a Node.js process; you run in Bun. NEVER kill Node processes by name: no `pkill node`, `pkill -f node`, `killall node`, `taskkill /IM node.exe`, or `Stop-Process -Name node`. Each of these kills the daemon (and any Node dev servers) and cuts you off mid-task without touching your own process — on Windows nothing restarts it. To stop a specific process, target its exact PID or listening port, never the `node` process name."

export const SUBSESSION_WORKFLOW_GUIDANCE =
  "## Chorus Task Workflow\nWhen working on a Chorus task:\n1. Start work: chorus_tool_execute({ toolName: \"chorus_update_task\", arguments: { taskUuid, status: \"in_progress\" } })\n2. Report progress: chorus_tool_execute({ toolName: \"chorus_report_work\", arguments: { taskUuid, report } })\n3. Self-check acceptance criteria against implementation\n4. Submit: chorus_tool_execute({ toolName: \"chorus_submit_for_verify\", arguments: { taskUuid, summary } })\nDo NOT call chorus_create_session or chorus_close_session."

export const PLAN_AGENT_GUIDANCE =
  "## Chorus AI-DLC Planning Workflow\nWhen planning implementation:\n1. Identify or create a Chorus Idea for this requirement\n2. Create a Proposal with document drafts and task drafts\n3. Set up the task dependency DAG\n4. Submit the Proposal for admin approval\n5. After approval, tasks materialize and can be claimed\nDo NOT start coding without an approved Chorus Proposal."

type SystemTransformInput = {
  sessionID?: string
}

type SystemTransformOutput = {
  system: string[]
}

type SystemTransformStateStore = {
  readOpenCodeState(): Promise<{
    sessionContext?: SessionContextRecord
    mainSession?: { runtimeSessionId?: string }
    activeAgent?: string
    activated?: boolean
  }>
  readSharedState?(): Promise<{ context?: { projectUuid?: string; projectName?: string; projectGroupUuid?: string } }>
}

type CreateSystemTransformHookOptions = {
  stagingDir?: string
  stateStore?: SystemTransformStateStore
  projectUuids?: string[]
  directory?: string
  ensureSessionContext?: (sessionID: string) => Promise<void>
  isOpenSpecAvailable?: () => Promise<boolean>
  enableSubsessionInjection?: boolean
  enablePlanAgentGuidance?: boolean
  enablePerTurnReminder?: boolean
}

type ProjectScope =
  | {
      kind: "managed"
      source: "config" | "shared" | "session"
      projectUuid?: string
      projectName?: string
    }
  | {
      kind: "ambiguous"
      source: "config" | "shared" | "session"
      projectGroupUuid?: string
      projectCount?: number
    }
  | {
      kind: "unmanaged"
    }

export function createSystemTransformHook(options: CreateSystemTransformHookOptions) {
  let openSpecAvailablePromise: Promise<boolean> | undefined
  let hasInjectedStagingGuidance = false

  const readOpenSpecAvailability = async () => {
    if (options.isOpenSpecAvailable) return options.isOpenSpecAvailable()
    if (!options.directory) return false
    openSpecAvailablePromise ??= detectOpenSpecAvailability(options.directory, () => isOpenSpecCliAvailable())
      .then((availability) => availability.available)
      .catch(() => false)
    return openSpecAvailablePromise
  }

  return async (input: SystemTransformInput, output: SystemTransformOutput): Promise<void> => {
    const activationState = await readOpenCodeStateSafe(options.stateStore)
    if (activationState?.activated === false) return

    await ensureSessionContextSafe(input.sessionID, options.ensureSessionContext)

    const contextState = await buildChorusSystemContext(input, options, readOpenSpecAvailability)
    const mainSessionId = contextState.state?.mainSession?.runtimeSessionId
    const activeAgent = contextState.state?.activeAgent
    const isSubSession = Boolean(input.sessionID && mainSessionId && input.sessionID !== mainSessionId)

    const chorusContext = contextState.context
    if (chorusContext) pushSystemMessageOnce(output, chorusContext)

    // Inject for BOTH main and sub sessions (sub-agents run bash too); no opt-out
    // flag by design — a safety rail you can silently disable isn't one.
    pushSystemMessageOnce(output, PROCESS_SAFETY_GUARDRAIL)

    if (!isSubSession && options.enablePerTurnReminder !== false) {
      pushSystemMessageOnce(output, PER_TURN_REMINDER)
    }

    if (options.stagingDir && !hasInjectedStagingGuidance) {
      pushSystemMessageOnce(output, formatStagingDirSystemGuidance(options.stagingDir))
      hasInjectedStagingGuidance = true
    }

    if (isSubSession && options.enableSubsessionInjection !== false) {
      pushSystemMessageOnce(output, SUBSESSION_WORKFLOW_GUIDANCE)
    }

    if (activeAgent === "plan" && options.enablePlanAgentGuidance !== false) {
      pushSystemMessageOnce(output, PLAN_AGENT_GUIDANCE)
    }
  }
}

async function ensureSessionContextSafe(
  sessionID: string | undefined,
  ensureSessionContext: ((sessionID: string) => Promise<void>) | undefined,
): Promise<void> {
  if (!sessionID || !ensureSessionContext) return
  try {
    await ensureSessionContext(sessionID)
  } catch {
    // System guidance is best-effort; fall back to whatever state is already cached.
  }
}

function pushSystemMessageOnce(output: SystemTransformOutput, message: string): void {
  if (output.system.includes(message)) return
  output.system.push(message)
}

async function buildChorusSystemContext(
  input: SystemTransformInput,
  options: CreateSystemTransformHookOptions,
  readOpenSpecAvailability: () => Promise<boolean>,
): Promise<{ context: string; state?: Awaited<ReturnType<typeof readOpenCodeStateSafe>> }> {
  const [state, sharedState, openSpecAvailable] = await Promise.all([
    readOpenCodeStateSafe(options.stateStore),
    readSharedStateSafe(options.stateStore),
    readOpenSpecAvailability(),
  ])

  const sessionContext = getMatchingSessionContext(state?.sessionContext, input.sessionID)
  const projectScope = resolveProjectScope({
    configuredProjectUuids: options.projectUuids ?? [],
    sharedContext: sharedState?.context,
    sessionContext,
  })

  const lines = ["Chorus Context:"]
  lines.push(`- Chorus project scope: ${projectScope.kind}`)

  if (projectScope.kind === "managed") {
    if (projectScope.projectName && projectScope.projectUuid) {
      lines.push(`- Project: ${projectScope.projectName} (${projectScope.projectUuid})`)
    } else if (projectScope.projectName) {
      lines.push(`- Project: ${projectScope.projectName}`)
    } else if (projectScope.projectUuid) {
      lines.push(`- Project UUID: ${projectScope.projectUuid}`)
    }
  }

  if (projectScope.kind === "ambiguous") {
    lines.push("- Multiple Chorus projects may apply here; do not assume projectUuid.")
    if (projectScope.projectGroupUuid) lines.push(`- Project group UUID: ${projectScope.projectGroupUuid}`)
    if (typeof projectScope.projectCount === "number") lines.push(`- Candidate project count: ${projectScope.projectCount}`)
  }

  if (projectScope.kind === "unmanaged") {
    lines.push("- This workspace is not linked to a single Chorus project; do not assume projectUuid.")
  }

  if (sessionContext?.agent?.name) lines.push(`- Agent: ${sessionContext.agent.name}`)

  const permissionsSummary = formatPermissions(sessionContext?.agent?.permissions)
  if (permissionsSummary) lines.push(`- Permissions: ${permissionsSummary}`)

  const ownerSummary = formatOwnerSummary(sessionContext?.owner)
  if (ownerSummary) lines.push(`- Owner: ${ownerSummary}`)

  lines.push(`- OpenSpec: ${openSpecAvailable ? "available" : "unavailable"}`)

  return { context: lines.join("\n"), state }
}

function resolveProjectScope(options: {
  configuredProjectUuids: string[]
  sharedContext?: { projectUuid?: string; projectName?: string; projectGroupUuid?: string }
  sessionContext?: SessionContextRecord
}): ProjectScope {
  const configuredProjectUuids = options.configuredProjectUuids.filter(Boolean)
  const sessionProjects = options.sessionContext?.projects ?? []

  if (configuredProjectUuids.length === 1) {
    const projectUuid = configuredProjectUuids[0]
    const projectName = sessionProjects.find((project) => project.uuid === projectUuid)?.name
    return { kind: "managed", source: "config", projectUuid, ...(projectName ? { projectName } : {}) }
  }

  if (options.sharedContext?.projectUuid) {
    const projectUuid = options.sharedContext.projectUuid
    const projectName = sessionProjects.find((project) => project.uuid === projectUuid)?.name ?? options.sharedContext.projectName
    return { kind: "managed", source: "shared", projectUuid, ...(projectName ? { projectName } : {}) }
  }

  if (options.sharedContext?.projectGroupUuid) {
    return {
      kind: "ambiguous",
      source: "shared",
      projectGroupUuid: options.sharedContext.projectGroupUuid,
      ...(sessionProjects.length > 0 ? { projectCount: sessionProjects.length } : {}),
    }
  }

  if (sessionProjects.length === 1) {
    return {
      kind: "managed",
      source: "session",
      projectUuid: sessionProjects[0]?.uuid,
      projectName: sessionProjects[0]?.name,
    }
  }

  if (sessionProjects.length > 1) {
    return { kind: "ambiguous", source: "session", projectCount: sessionProjects.length }
  }

  if (configuredProjectUuids.length > 1) {
    return { kind: "ambiguous", source: "config", projectCount: configuredProjectUuids.length }
  }

  return { kind: "unmanaged" }
}

async function readOpenCodeStateSafe(
  stateStore: SystemTransformStateStore | undefined,
): Promise<Awaited<ReturnType<SystemTransformStateStore["readOpenCodeState"]>> | undefined> {
  if (!stateStore) return undefined
  try {
    return await stateStore.readOpenCodeState()
  } catch {
    return undefined
  }
}

async function readSharedStateSafe(
  stateStore: SystemTransformStateStore | undefined,
): Promise<{ context?: { projectUuid?: string; projectName?: string; projectGroupUuid?: string } } | undefined> {
  if (!stateStore?.readSharedState) return undefined
  try {
    return await stateStore.readSharedState()
  } catch {
    return undefined
  }
}

function getMatchingSessionContext(
  sessionContext: SessionContextRecord | undefined,
  sessionID: string | undefined,
): SessionContextRecord | undefined {
  if (!sessionContext || !sessionID) return undefined
  return sessionContext.runtimeSessionId === sessionID ? sessionContext : undefined
}

function formatOwnerSummary(owner: SessionContextRecord["owner"]): string | undefined {
  if (!owner) return undefined
  if (owner.name && owner.uuid) return `${owner.name} (${owner.uuid})`
  return owner.name ?? owner.uuid
}
