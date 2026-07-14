import type { PluginInput } from "@opencode-ai/plugin"
import type { ChorusMcpClient } from "../chorus/mcp-client"
import type { StateStore } from "../state/state-store"
import { evaluateNotificationScope, resolveEffectiveNotificationScope } from "./notification-scope"
import {
  claimNextQueuedNotification,
  enqueueRoutedNotification,
  markQueuedNotificationDone,
  markQueuedNotificationFailed,
} from "./notification-dispatcher"
import {
  fetchNotificationByUuid,
  fetchNotifications,
  filterNotificationsCreatedAfter,
  newestNotificationCreatedAt,
  sortNotificationsByCreatedAtAsc,
  type ChorusNotification,
} from "./notification-pagination"
import { routeNotification } from "./notification-router"
import { createChorusSseListener } from "./sse-listener-factory"
import type { ChorusSseListener, SseListenerStatus, SseNotificationEvent } from "./sse-listener"

type Logger = {
  debug(message: string, extra?: Record<string, unknown>): Promise<void>
  info(message: string, extra?: Record<string, unknown>): Promise<void>
  warn(message: string, extra?: Record<string, unknown>): Promise<void>
  error(message: string, extra?: Record<string, unknown>): Promise<void>
}

type NotificationCoordinatorOptions = {
  chorusUrl: string
  apiKey: string
  /** Daemon-injected AgentInstance uuid (woken sessions); fallback identity before SSE handshake. */
  instanceUuid?: string
  projectUuids?: string[]
  enableNotificationHints: boolean
  directory: string
  stateStore: StateStore
  chorusClient: ChorusMcpClient
  client: PluginInput["client"]
  logger: Logger
}

export class NotificationCoordinator {
  private listener: ChorusSseListener | null = null
  private drainPromise: Promise<void> | null = null
  private started = false

  constructor(private readonly options: NotificationCoordinatorOptions) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const initialCursor = await this.readLatestNotificationCreatedAt()
    this.listener = createChorusSseListener(this.options.chorusUrl, this.options.apiKey, (event) => {
      void this.handleSseEvent(event).catch((error) =>
        this.options.logger.error("Failed to process Chorus notification event", {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }, {
      onConnect: async () => {
        await this.catchUpNotifications(initialCursor).catch((error) =>
          this.options.logger.warn("Failed to catch up Chorus notifications after listener connect", {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      },
      onReconnect: async () => {
        await this.catchUpNotifications().catch((error) =>
          this.options.logger.warn("Failed to backfill Chorus notifications after reconnect", {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      },
      onStatusChange: async (status, error) => {
        await this.updateRuntimeStatus(status, error)
      },
    })

    void this.listener.connect().catch((error) =>
      this.options.logger.warn("Chorus notification listener stopped", {
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  stop(): void {
    this.listener?.disconnect()
    this.listener = null
    this.started = false
  }

  async handleSseEvent(event: SseNotificationEvent): Promise<void> {
    if (event.type !== "new_notification" || !event.notificationUuid) return

    // Directed-delivery suppression (mirrors the daemon's EventRouter): the
    // notification stream is per-AGENT, so every connection gets a copy of a
    // pinned wake. A copy addressed to a DIFFERENT instance must be ignored,
    // otherwise a busy session in directory B happily executes work pinned to
    // directory A. suppressWake marks an offline pin: nobody may act on it.
    if (event.suppressWake === true) return
    const target =
      typeof event.targetConnectionUuid === "string" && event.targetConnectionUuid
        ? event.targetConnectionUuid
        : null
    if (target) {
      const me = this.listener?.connectionUuid ?? this.options.instanceUuid ?? null
      if (target !== me) {
        await this.options.logger.info("Suppressed a Chorus notification directed to another instance", {
          notificationUuid: event.notificationUuid,
          target,
          self: me,
        })
        return
      }
    }
    const notification = await fetchNotificationByUuid(this.options.chorusClient, event.notificationUuid)
    if (!notification) {
      await this.options.logger.warn("Chorus notification SSE event could not be resolved", {
        notificationUuid: event.notificationUuid,
      })
      return
    }
    await this.recordNotificationProgress([notification])

    const routed = routeNotification(
      { ...notification, notificationUuid: notification.uuid ?? notification.notificationUuid ?? event.notificationUuid },
      { enableNotificationHints: this.options.enableNotificationHints },
    )
    if (routed.kind === "ignored") return

    const scopeEvaluation = await this.evaluateScope(notification)
    await this.recordScopeEvaluation(routed.notificationUuid, scopeEvaluation)
    if (shouldSuppressDelivery(routed.delivery, scopeEvaluation.outcome)) return

    await enqueueRoutedNotification(this.options.stateStore, routed)
    await this.showToast(routed.title, routed.toastMessage, routed.kind === "task_reopened" || routed.kind === "proposal_rejected" ? "warning" : "info")
    await this.updateRuntimeStatus(this.listener?.status ?? "connected")
  }

  async handleSessionReady(sessionId: string): Promise<void> {
    await this.drain(sessionId)
  }

  async handleSessionIdle(sessionId: string): Promise<void> {
    await this.drain(sessionId)
  }

  private async catchUpNotifications(afterCreatedAt?: string): Promise<void> {
    const state = await this.options.stateStore.readOpenCodeState()
    const cursor = afterCreatedAt ?? state.checkpoints.lastNotificationCreatedAt
    const notifications = await fetchNotifications(this.options.chorusClient)
    const pendingBackfill = sortNotificationsByCreatedAtAsc(filterNotificationsCreatedAfter(notifications, cursor))

    for (const notification of pendingBackfill) {
      const routed = routeNotification(
        {
          ...notification,
          notificationUuid: notification.uuid ?? notification.notificationUuid,
        },
        { enableNotificationHints: this.options.enableNotificationHints },
      )
      if (routed.kind === "ignored") continue
      const scopeEvaluation = await this.evaluateScope(notification)
      await this.recordScopeEvaluation(routed.notificationUuid, scopeEvaluation)
      if (shouldSuppressDelivery(routed.delivery, scopeEvaluation.outcome)) continue
      await enqueueRoutedNotification(this.options.stateStore, routed)
    }

    await this.recordNotificationProgress(notifications, { backfill: true })
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.drainPromise) return this.drainPromise

    const promise = this.performDrain(sessionId)
    this.drainPromise = promise
    try {
      await promise
    } finally {
      if (this.drainPromise === promise) this.drainPromise = null
    }
  }

  private async performDrain(sessionId: string): Promise<void> {
    const state = await this.options.stateStore.readOpenCodeState()
    if (state.mainSession.runtimeSessionId !== sessionId) return

    for (let delivered = 0; delivered < 5; delivered += 1) {
      const next = await claimNextQueuedNotification(this.options.stateStore)
      if (!next) return

      try {
        await this.options.client.session.prompt({
          path: { id: sessionId },
          query: { directory: this.options.directory },
          body: {
            ...(next.delivery === "context_only" ? { noReply: true } : {}),
            parts: [{ type: "text", text: next.prompt }],
          },
        })
        await markQueuedNotificationDone(this.options.stateStore, next.notificationUuid)
      } catch (error) {
        await markQueuedNotificationFailed(
          this.options.stateStore,
          next.notificationUuid,
          error instanceof Error ? error.message : String(error),
        )
        return
      }

      if (next.delivery === "assistant_turn") return
    }
  }

  private async updateRuntimeStatus(status: SseListenerStatus, error?: string): Promise<void> {
    const now = new Date().toISOString()
    await this.options.stateStore.updateOpenCodeState((state) => ({
      ...state,
      notificationRuntime: {
        status,
        ...(state.notificationRuntime?.lastEventAt ? { lastEventAt: state.notificationRuntime.lastEventAt } : {}),
        ...(state.notificationRuntime?.lastScopeEvaluation
          ? { lastScopeEvaluation: state.notificationRuntime.lastScopeEvaluation }
          : {}),
        ...(status === "connected" ? { lastConnectedAt: now } : {}),
        ...(status === "reconnecting" ? { lastReconnectAt: now } : {}),
        ...(error ? { lastError: error } : {}),
      },
    }))
  }

  private async readLatestNotificationCreatedAt(): Promise<string | undefined> {
    try {
      const notifications = await fetchNotifications(this.options.chorusClient, {
        status: "all",
        limit: 1,
        maxPages: 1,
      })
      return newestNotificationCreatedAt(notifications)
    } catch (error) {
      await this.options.logger.warn("Failed to read latest Chorus notification checkpoint", {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  private async recordNotificationProgress(
    notifications: ChorusNotification[],
    options: { backfill?: boolean } = {},
  ): Promise<void> {
    const now = new Date().toISOString()
    const newestCreatedAt = newestNotificationCreatedAt(notifications)

    await this.options.stateStore.updateOpenCodeState((state) => ({
      ...state,
      notificationRuntime: {
        ...(state.notificationRuntime ?? { status: this.listener?.status ?? "disconnected" }),
        ...(notifications.length > 0 ? { lastEventAt: now } : {}),
        ...(state.notificationRuntime?.lastScopeEvaluation
          ? { lastScopeEvaluation: state.notificationRuntime.lastScopeEvaluation }
          : {}),
      },
      checkpoints: {
        ...state.checkpoints,
        ...(options.backfill ? { lastUnreadBackfillAt: now } : {}),
        ...(newestCreatedAt
          ? {
              lastNotificationCreatedAt: maxIsoTimestamp(
                state.checkpoints.lastNotificationCreatedAt,
                newestCreatedAt,
              ),
            }
          : {}),
      },
    }))
  }

  private async evaluateScope(notification: ChorusNotification) {
    const [state, sharedState] = await Promise.all([
      this.options.stateStore.readOpenCodeState(),
      this.options.stateStore.readSharedState(),
    ])
    const scope = resolveEffectiveNotificationScope({
      configuredProjectUuids: this.options.projectUuids ?? [],
      sharedProjectUuid: sharedState.context.projectUuid,
      sessionProjects: state.sessionContext?.projects,
    })
    return evaluateNotificationScope(notification, scope)
  }

  private async recordScopeEvaluation(notificationUuid: string, evaluation: Awaited<ReturnType<NotificationCoordinator["evaluateScope"]>>): Promise<void> {
    await this.options.stateStore.updateOpenCodeState((state) => ({
      ...state,
      notificationRuntime: {
        ...(state.notificationRuntime ?? { status: this.listener?.status ?? "disconnected" }),
        lastScopeEvaluation: {
          notificationUuid,
          ...evaluation,
          recordedAt: new Date().toISOString(),
        },
      },
    }))
  }

  private async showToast(title: string, message: string, variant: "info" | "success" | "warning" | "error"): Promise<void> {
    try {
      await this.options.client.tui?.showToast({
        body: {
          title,
          message,
          variant,
          duration: 4_000,
        },
        query: { directory: this.options.directory },
      })
    } catch {
      // Ignore toast delivery issues.
    }
  }
}

function maxIsoTimestamp(left: string | undefined, right: string): string {
  if (!left) return right
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function shouldSuppressDelivery(
  delivery: "assistant_turn" | "context_only",
  outcome: "in_scope" | "out_of_scope" | "unresolved",
): boolean {
  if (outcome === "out_of_scope") return true
  if (outcome === "unresolved" && delivery === "assistant_turn") return true
  return false
}
