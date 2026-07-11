import type { Plugin } from "@opencode-ai/plugin"
import { createChorusMcpClient } from "./chorus/mcp-client-factory"
import { loadChorusConfig } from "./config/config-loader"
import { isMissingRequiredConfigError } from "./config/error-guards"
import { createPluginConfigApplier } from "./config/plugin-config"
import { createPluginEventHook } from "./hooks/plugin-event-hook"
import { createPermissionAskHook } from "./hooks/permission-ask-hook"
import { createSystemTransformHook } from "./hooks/system-transform-hook"
import { createToolExecuteAfterHook } from "./hooks/tool-execute-after-hook"
import { ChorusReadiness } from "./lifecycle/chorus-readiness"
import { PlanningLifecycle } from "./lifecycle/planning-lifecycle"
import { SessionLifecycle } from "./lifecycle/session-lifecycle"
import { NotificationCoordinator } from "./notifications/notification-coordinator"
import { ReviewerToastCoordinator } from "./reviewers/reviewer-toast"
import { DaemonManager } from "./daemon/daemon-manager"
import { StateStore } from "./state/state-store"
import { createDaemonTool } from "./tools/daemon-tool"
import { createChorusLazyBridge } from "./tools/lazy-bridge-tools"
import { createLogger } from "./util/logger"

const REVIEWER_AGENTS = new Set(["proposal-reviewer", "task-reviewer"])

export const createPlugin: Plugin = async (ctx, options) => {
  const logger = createLogger(ctx.client)
  let loadedConfig
  try {
    loadedConfig = await loadChorusConfig(options ?? {})
  } catch (error) {
    if (isMissingRequiredConfigError(error)) {
      return {
        config: createPluginConfigApplier(),
      }
    }
    throw error
  }
  const config = loadedConfig.config
  const applyPluginConfig = createPluginConfigApplier()
  const stateStore = new StateStore({
    projectRoot: ctx.directory,
    worktree: ctx.worktree,
    stateMode: config.stateMode,
    stateDir: config.stateDir,
    globalStateRoot: config.globalStateRoot,
  })
  await stateStore.init()
  const chorusClient = createChorusMcpClient({
    chorusUrl: config.chorusUrl,
    apiKey: config.apiKey,
  })
  // Forward reference so lazyBridge and readiness can reference each other.
  // readiness is assigned below before either is ever called at runtime.
  const readinessRef: { current: ChorusReadiness | null } = { current: null }
  const lazyBridge = createChorusLazyBridge({
    chorusClient,
    stateStore,
    chorusUrl: config.chorusUrl,
    stagingDir: stateStore.paths.stagingDir,
    readiness: {
      ensureReady: (sessionId, mode) => readinessRef.current?.ensureReady(sessionId, mode) ?? Promise.resolve(),
    },
  })
  const sessionLifecycle = new SessionLifecycle(stateStore, chorusClient, config.chorusUrl)
  // Local daemon management (embedded-daemon): the unattended wake service ships
  // inside this package and is installed/driven via the chorus_daemon tool. It
  // reuses the SAME agent credentials this plugin resolved.
  const daemonTool = createDaemonTool({
    manager: new DaemonManager({ chorusUrl: config.chorusUrl, apiKey: config.apiKey }),
    logger,
  })
  const tui = ctx.client.tui
    ? {
        showToast: async (input: { title?: string; message?: string; variant?: "info" | "success" | "warning" | "error"; duration?: number }) => {
          await ctx.client.tui.showToast({ body: { ...input, message: input.message ?? "", variant: input.variant ?? "info" } })
        },
      }
    : undefined
  readinessRef.current = new ChorusReadiness({
    sessionLifecycle,
    chorusClient,
    stateStore,
    lazyBridge,
    onReady: async () => {
      await notificationCoordinator.start()
    },
    tui,
    directory: ctx.directory,
    enableSessionContextSummary: config.enableSessionContextSummary,
    logger,
    stagingDir: stateStore.paths.stagingDir,
  })
  const readiness = readinessRef.current
  const planningLifecycle = new PlanningLifecycle(stateStore)
  const reviewerToast = new ReviewerToastCoordinator({
    tui,
    runningToastDurationMs: config.reviewerWaitTimeoutMs,
  })
  const notificationCoordinator = new NotificationCoordinator({
    chorusUrl: config.chorusUrl,
    apiKey: config.apiKey,
    projectUuids: config.projectUuids,
    enableNotificationHints: config.enableNotificationHints,
    directory: ctx.directory,
    stateStore,
    chorusClient,
    client: ctx.client,
    logger,
  })
  const eventHook = createPluginEventHook({
    stateStore,
    sessionLifecycle,
    logger,
    onSessionReady: async (sessionId) => {
      await autoActivateBoundWorkspace(sessionId)
      await notificationCoordinator.handleSessionReady(sessionId)
    },
    onSessionIdle: async (sessionId) => {
      await notificationCoordinator.handleSessionIdle(sessionId)
    },
    onSessionEnded: async (sessionId, details) => {
      if (details.trackedMainSession) notificationCoordinator.stop()
      readiness.markSessionEnded(sessionId)
    },
  })
  const toolExecuteAfterHook = createToolExecuteAfterHook({
    config,
    stateStore,
    planningLifecycle,
    context: {
      client: ctx.client,
      directory: ctx.directory,
    },
    chorusClient,
    reviewerToast,
  })
  const permissionAskHook = createPermissionAskHook({
    stagingDir: stateStore.paths.stagingDir,
  })
  const systemTransformHook = createSystemTransformHook({
    stateStore,
    projectUuids: config.projectUuids,
    directory: ctx.directory,
    stagingDir: stateStore.paths.stagingDir,
    ensureSessionContext: (sessionID) => sessionLifecycle.start(sessionID),
    enableSubsessionInjection: config.enableSubsessionInjection,
    enablePlanAgentGuidance: config.enablePlanAgentGuidance,
    enablePerTurnReminder: config.enablePerTurnReminder,
  })
  if (loadedConfig.metadata.apiKeySource === "chorus.json") {
    await logger.warn("Chorus API key was loaded from chorus.json; prefer CHORUS_API_KEY for secrets.")
  }
  if (loadedConfig.metadata.stateDirSource && config.stateMode !== "project") {
    await logger.warn("Chorus stateDir is deprecated and ignored unless stateMode is project.")
  }
  if (stateStore.fallbackReason) {
    await logger.warn("Fell back to project-local Chorus state", { reason: stateStore.fallbackReason })
  }
  await logger.info("Initializing opencode-chorus", {
    directory: ctx.directory,
    worktree: ctx.worktree,
    chorusUrl: config.chorusUrl,
    stateMode: stateStore.paths.mode,
    stateFile: stateStore.paths.stateFile,
  })

  const hydrateSessionContext = async (sessionID: string, agent: string) => {
    if (REVIEWER_AGENTS.has(agent)) return
    if (config.enableSessionContextSummary) {
      await sessionLifecycle.surfaceContextSummary(sessionID, logger, stateStore.paths.stagingDir)
    }
  }

  const autoActivateBoundWorkspace = async (sessionID: string, mode: "visible" | "silent" = "visible") => {
    const sharedState = await stateStore.readSharedState().catch(() => undefined)
    if (!sharedState?.context.projectUuid) return

    try {
      await readiness.ensureReady(sessionID, mode)
    } catch (error) {
      await logger.warn("Chorus auto-activation from workspace context failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    config: applyPluginConfig,
    event: eventHook,
    "permission.ask": permissionAskHook,
    "tool.execute.after": toolExecuteAfterHook,
    "experimental.chat.system.transform": systemTransformHook,
    "chat.message": async ({ agent }) => {
      if (agent) stateStore.setActiveAgent(agent)
    },
    "chat.params": async ({ sessionID, agent }) => {
      stateStore.setActiveAgent(agent)
      await autoActivateBoundWorkspace(sessionID, REVIEWER_AGENTS.has(agent) ? "silent" : "visible")
      await hydrateSessionContext(sessionID, agent).catch(async (error) => {
        await logger.warn("Chorus session context hydration failed on chat.params", {
          error: error instanceof Error ? error.message : String(error),
          agent,
        })
      })
    },
    tool: { ...lazyBridge.tools, chorus_daemon: daemonTool },
  }
}

export const ChorusPlugin: Plugin = async (ctx, options) => createPlugin(ctx, options)

export default ChorusPlugin
