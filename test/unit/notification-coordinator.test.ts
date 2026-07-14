import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NotificationCoordinator } from "../../src/notifications/notification-coordinator"
import { StateStore } from "../../src/state/state-store"

describe("NotificationCoordinator", () => {
  it("delivers an assistant-turn notification on session idle and marks it done", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-notification-coordinator-"))
    const stateStore = new StateStore(rootDir, ".chorus")
    const promptCalls: Array<Record<string, unknown>> = []

    try {
      await stateStore.updateOpenCodeState((state) => ({
        ...state,
        mainSession: { ...state.mainSession, runtimeSessionId: "main-session", status: "active" },
        notificationQueue: [
          {
            id: "notif-1",
            notificationUuid: "notif-1",
            kind: "task_verified",
            delivery: "assistant_turn",
            entityUuid: "task-1",
            projectUuid: "proj-1",
            title: "Task verified",
            toastMessage: "Task A verified",
            prompt: "Use chorus_get_unblocked_tasks for project proj-1.",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            attempts: 0,
            status: "pending",
          },
        ],
      }))

      const coordinator = new NotificationCoordinator({
        chorusUrl: "http://chorus.test",
        apiKey: "key",
        projectUuids: ["proj-1"],
        enableNotificationHints: true,
        directory: rootDir,
        stateStore,
        chorusClient: { callTool: async () => ({ notifications: [] }) } as never,
        client: {
          session: {
            prompt: async (input: Record<string, unknown>) => {
              promptCalls.push(input)
              return {}
            },
          },
          tui: {
            showToast: async () => true,
          },
        } as never,
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      })

      await coordinator.handleSessionIdle("main-session")

      expect(promptCalls).toHaveLength(1)
      expect(promptCalls[0]).toMatchObject({
        path: { id: "main-session" },
        body: { parts: [{ type: "text", text: "Use chorus_get_unblocked_tasks for project proj-1." }] },
      })

      const state = await stateStore.readOpenCodeState()
      expect(state.notificationQueue[0]?.status).toBe("done")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("delivers context-only notifications with noReply enabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-notification-coordinator-"))
    const stateStore = new StateStore(rootDir, ".chorus")
    const promptCalls: Array<Record<string, unknown>> = []

    try {
      await stateStore.updateOpenCodeState((state) => ({
        ...state,
        mainSession: { ...state.mainSession, runtimeSessionId: "main-session", status: "active" },
        notificationQueue: [
          {
            id: "notif-1",
            notificationUuid: "notif-1",
            kind: "task_assigned",
            delivery: "context_only",
            entityUuid: "task-1",
            projectUuid: "proj-1",
            title: "Task assigned",
            toastMessage: "Task A assigned",
            prompt: "Review task task-1.",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            attempts: 0,
            status: "pending",
          },
        ],
      }))

      const coordinator = new NotificationCoordinator({
        chorusUrl: "http://chorus.test",
        apiKey: "key",
        enableNotificationHints: false,
        directory: rootDir,
        stateStore,
        chorusClient: { callTool: async () => ({ notifications: [] }) } as never,
        client: {
          session: {
            prompt: async (input: Record<string, unknown>) => {
              promptCalls.push(input)
              return {}
            },
          },
          tui: {
            showToast: async () => true,
          },
        } as never,
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      })

      await coordinator.handleSessionIdle("main-session")

      expect(promptCalls).toHaveLength(1)
      expect(promptCalls[0]).toMatchObject({
        path: { id: "main-session" },
        body: { noReply: true, parts: [{ type: "text", text: "Review task task-1." }] },
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("handles a new SSE notification by queueing it and showing a toast", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-notification-coordinator-"))
    const stateStore = new StateStore(rootDir, ".chorus")
    const toastCalls: Array<Record<string, unknown>> = []

    try {
      const coordinator = new NotificationCoordinator({
        chorusUrl: "http://chorus.test",
        apiKey: "key",
        projectUuids: ["proj-1"],
        enableNotificationHints: true,
        directory: rootDir,
        stateStore,
        chorusClient: {
          callTool: async (_toolName: string, args: Record<string, unknown>) => ({
            notifications: [
              {
                uuid: args.offset === 0 ? "notif-verified" : undefined,
                action: "task_verified",
                entityUuid: "task-1",
                projectUuid: "proj-1",
                entityTitle: "Task A",
                readAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        } as never,
        client: {
          session: {
            prompt: async () => ({}),
          },
          tui: {
            showToast: async (input: Record<string, unknown>) => {
              toastCalls.push(input)
              return true
            },
          },
        } as never,
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      })

      await coordinator.handleSseEvent({ type: "new_notification", notificationUuid: "notif-verified" })

      const state = await stateStore.readOpenCodeState()
      expect(state.notificationQueue).toHaveLength(1)
      expect(state.notificationQueue[0]).toMatchObject({
        notificationUuid: "notif-verified",
        kind: "task_verified",
        status: "pending",
      })
      expect(toastCalls).toHaveLength(1)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("does not enqueue a live SSE notification when it is outside the effective project scope", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-notification-coordinator-"))
    const stateStore = new StateStore(rootDir, ".chorus")
    const toastCalls: Array<Record<string, unknown>> = []
    const promptCalls: Array<Record<string, unknown>> = []

    try {
      await stateStore.updateOpenCodeState((state) => ({
        ...state,
        mainSession: { ...state.mainSession, runtimeSessionId: "main-session", status: "active" },
      }))

      const coordinator = new NotificationCoordinator({
        chorusUrl: "http://chorus.test",
        apiKey: "key",
        projectUuids: ["proj-allowed"],
        enableNotificationHints: true,
        directory: rootDir,
        stateStore,
        chorusClient: {
          callTool: async (_toolName: string, args: Record<string, unknown>) => ({
            notifications: [
              {
                uuid: args.offset === 0 ? "notif-out" : undefined,
                action: "task_verified",
                entityUuid: "task-1",
                projectUuid: "proj-other",
                entityTitle: "Task A",
                createdAt: "2026-01-01T00:00:00.000Z",
                readAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        } as never,
        client: {
          session: {
            prompt: async (input: Record<string, unknown>) => {
              promptCalls.push(input)
              return {}
            },
          },
          tui: {
            showToast: async (input: Record<string, unknown>) => {
              toastCalls.push(input)
              return true
            },
          },
        } as never,
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      })

      await coordinator.handleSseEvent({ type: "new_notification", notificationUuid: "notif-out" })
      await coordinator.handleSessionIdle("main-session")

      const state = await stateStore.readOpenCodeState()
      expect(state.notificationQueue).toHaveLength(0)
      expect(state.notificationRuntime?.lastScopeEvaluation).toMatchObject({
        notificationUuid: "notif-out",
        outcome: "out_of_scope",
        reason: "project_not_in_scope",
      })
      expect(promptCalls).toHaveLength(0)
      expect(toastCalls).toHaveLength(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("filters out-of-scope notifications during backfill before enqueue", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-notification-coordinator-"))
    const stateStore = new StateStore(rootDir, ".chorus")

    try {
      const coordinator = new NotificationCoordinator({
        chorusUrl: "http://chorus.test",
        apiKey: "key",
        projectUuids: ["proj-allowed"],
        enableNotificationHints: true,
        directory: rootDir,
        stateStore,
        chorusClient: {
          callTool: async () => ({
            notifications: [
              {
                uuid: "notif-in",
                action: "task_verified",
                entityUuid: "task-1",
                projectUuid: "proj-allowed",
                entityTitle: "Task In",
                createdAt: "2026-01-01T00:00:02.000Z",
                readAt: "2026-01-01T00:00:02.000Z",
              },
              {
                uuid: "notif-out",
                action: "task_verified",
                entityUuid: "task-2",
                projectUuid: "proj-other",
                entityTitle: "Task Out",
                createdAt: "2026-01-01T00:00:03.000Z",
                readAt: "2026-01-01T00:00:03.000Z",
              },
            ],
          }),
        } as never,
        client: {
          session: { prompt: async () => ({}) },
          tui: { showToast: async () => true },
        } as never,
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      })

      await stateStore.updateOpenCodeState((state) => ({
        ...state,
        checkpoints: {
          ...state.checkpoints,
          lastNotificationCreatedAt: "2026-01-01T00:00:01.000Z",
        },
      }))

      await (coordinator as any).catchUpNotifications()

      const state = await stateStore.readOpenCodeState()
      expect(state.notificationQueue).toHaveLength(1)
      expect(state.notificationQueue[0]).toMatchObject({
        notificationUuid: "notif-in",
        projectUuid: "proj-allowed",
      })
      expect(state.notificationQueue.some((item) => item.notificationUuid === "notif-out")).toBe(false)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("suppresses assistant-turn delivery when a live notification is missing project scope", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-notification-coordinator-"))
    const stateStore = new StateStore(rootDir, ".chorus")
    const toastCalls: Array<Record<string, unknown>> = []

    try {
      const coordinator = new NotificationCoordinator({
        chorusUrl: "http://chorus.test",
        apiKey: "key",
        projectUuids: ["proj-allowed"],
        enableNotificationHints: true,
        directory: rootDir,
        stateStore,
        chorusClient: {
          callTool: async (_toolName: string, args: Record<string, unknown>) => ({
            notifications: [
              {
                uuid: args.offset === 0 ? "notif-missing-project" : undefined,
                action: "task_verified",
                entityUuid: "task-1",
                entityTitle: "Task Missing Project",
                createdAt: "2026-01-01T00:00:00.000Z",
                readAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        } as never,
        client: {
          session: { prompt: async () => ({}) },
          tui: {
            showToast: async (input: Record<string, unknown>) => {
              toastCalls.push(input)
              return true
            },
          },
        } as never,
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      })

      await coordinator.handleSseEvent({ type: "new_notification", notificationUuid: "notif-missing-project" })

      const state = await stateStore.readOpenCodeState()
      expect(state.notificationQueue).toHaveLength(0)
      expect(state.notificationRuntime?.lastScopeEvaluation).toMatchObject({
        notificationUuid: "notif-missing-project",
        outcome: "unresolved",
        reason: "missing_notification_project",
      })
      expect(toastCalls).toHaveLength(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("suppresses assistant-turn backfill delivery when effective scope is unresolved", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-notification-coordinator-"))
    const stateStore = new StateStore(rootDir, ".chorus")

    try {
      await stateStore.updateOpenCodeState((state) => ({
        ...state,
        sessionContext: {
          source: "chorus_checkin",
          runtimeSessionId: "main-session",
          lastRefreshedAt: "2026-01-01T00:00:00.000Z",
          projects: [
            { uuid: "proj-a", name: "Project A" },
            { uuid: "proj-b", name: "Project B" },
          ],
        },
        checkpoints: {
          ...state.checkpoints,
          lastNotificationCreatedAt: "2026-01-01T00:00:01.000Z",
        },
      }))

      const coordinator = new NotificationCoordinator({
        chorusUrl: "http://chorus.test",
        apiKey: "key",
        enableNotificationHints: true,
        directory: rootDir,
        stateStore,
        chorusClient: {
          callTool: async () => ({
            notifications: [
              {
                uuid: "notif-unresolved-scope",
                action: "task_verified",
                entityUuid: "task-1",
                projectUuid: "proj-a",
                entityTitle: "Task Ambiguous Scope",
                createdAt: "2026-01-01T00:00:02.000Z",
                readAt: "2026-01-01T00:00:02.000Z",
              },
            ],
          }),
        } as never,
        client: {
          session: { prompt: async () => ({}) },
          tui: { showToast: async () => true },
        } as never,
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      })

      await (coordinator as any).catchUpNotifications()

      const state = await stateStore.readOpenCodeState()
      expect(state.notificationQueue).toHaveLength(0)
      expect(state.notificationRuntime?.lastScopeEvaluation).toMatchObject({
        notificationUuid: "notif-unresolved-scope",
        outcome: "unresolved",
        reason: "multiple_session_projects",
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("does not deliver queued notifications before the main session is established", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-notification-coordinator-"))
    const stateStore = new StateStore(rootDir, ".chorus")
    const promptCalls: Array<Record<string, unknown>> = []

    try {
      await stateStore.updateOpenCodeState((state) => ({
        ...state,
        mainSession: { status: "idle" },
        notificationQueue: [
          {
            id: "notif-1",
            notificationUuid: "notif-1",
            kind: "task_verified",
            delivery: "assistant_turn",
            entityUuid: "task-1",
            projectUuid: "proj-1",
            title: "Task verified",
            toastMessage: "Task A verified",
            prompt: "Use chorus_get_unblocked_tasks for project proj-1.",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            attempts: 0,
            status: "pending",
          },
        ],
      }))

      const coordinator = new NotificationCoordinator({
        chorusUrl: "http://chorus.test",
        apiKey: "key",
        enableNotificationHints: true,
        directory: rootDir,
        stateStore,
        chorusClient: { callTool: async () => ({ notifications: [] }) } as never,
        client: {
          session: {
            prompt: async (input: Record<string, unknown>) => {
              promptCalls.push(input)
              return {}
            },
          },
          tui: {
            showToast: async () => true,
          },
        } as never,
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      })

      await coordinator.handleSessionIdle("non-main-session")

      expect(promptCalls).toHaveLength(0)
      const state = await stateStore.readOpenCodeState()
      expect(state.notificationQueue[0]?.status).toBe("pending")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("allows only the tracked main session to consume assistant-turn notifications", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-notification-coordinator-"))
    const stateStore = new StateStore(rootDir, ".chorus")
    const promptCalls: Array<Record<string, unknown>> = []

    try {
      await stateStore.updateOpenCodeState((state) => ({
        ...state,
        mainSession: { ...state.mainSession, runtimeSessionId: "main-session", status: "active" },
        notificationQueue: [
          {
            id: "notif-1",
            notificationUuid: "notif-1",
            kind: "task_verified",
            delivery: "assistant_turn",
            entityUuid: "task-1",
            projectUuid: "proj-1",
            title: "Task verified",
            toastMessage: "Task A verified",
            prompt: "Use chorus_get_unblocked_tasks for project proj-1.",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            attempts: 0,
            status: "pending",
          },
        ],
      }))

      const coordinator = new NotificationCoordinator({
        chorusUrl: "http://chorus.test",
        apiKey: "key",
        enableNotificationHints: true,
        directory: rootDir,
        stateStore,
        chorusClient: { callTool: async () => ({ notifications: [] }) } as never,
        client: {
          session: {
            prompt: async (input: Record<string, unknown>) => {
              promptCalls.push(input)
              return {}
            },
          },
          tui: {
            showToast: async () => true,
          },
        } as never,
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      })

      await coordinator.handleSessionReady("non-owner-session")
      await coordinator.handleSessionIdle("non-owner-session")

      let state = await stateStore.readOpenCodeState()
      expect(promptCalls).toHaveLength(0)
      expect(state.notificationQueue[0]?.status).toBe("pending")

      await coordinator.handleSessionIdle("main-session")

      state = await stateStore.readOpenCodeState()
      expect(promptCalls).toHaveLength(1)
      expect(promptCalls[0]).toMatchObject({
        path: { id: "main-session" },
      })
      expect(state.notificationQueue[0]?.status).toBe("done")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("preserves pending assistant-turn notifications across main-session replacement until the replacement owner drains them", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-notification-coordinator-"))
    const stateStore = new StateStore(rootDir, ".chorus")
    const promptCalls: Array<Record<string, unknown>> = []

    try {
      await stateStore.updateOpenCodeState((state) => ({
        ...state,
        mainSession: { ...state.mainSession, runtimeSessionId: "old-main-session", status: "active" },
        notificationQueue: [
          {
            id: "notif-handoff",
            notificationUuid: "notif-handoff",
            kind: "task_verified",
            delivery: "assistant_turn",
            entityUuid: "task-1",
            projectUuid: "proj-1",
            title: "Task verified",
            toastMessage: "Task A verified",
            prompt: "Use chorus_get_unblocked_tasks for project proj-1.",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            attempts: 0,
            status: "pending",
          },
        ],
      }))

      const coordinator = new NotificationCoordinator({
        chorusUrl: "http://chorus.test",
        apiKey: "key",
        enableNotificationHints: true,
        directory: rootDir,
        stateStore,
        chorusClient: { callTool: async () => ({ notifications: [] }) } as never,
        client: {
          session: {
            prompt: async (input: Record<string, unknown>) => {
              promptCalls.push(input)
              return {}
            },
          },
          tui: {
            showToast: async () => true,
          },
        } as never,
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      })

      await coordinator.handleSessionReady("replacement-session")
      await coordinator.handleSessionIdle("replacement-session")

      let state = await stateStore.readOpenCodeState()
      expect(promptCalls).toHaveLength(0)
      expect(state.notificationQueue[0]?.status).toBe("pending")

      await stateStore.updateOpenCodeState((current) => ({
        ...current,
        mainSession: { status: "closed" },
      }))

      await coordinator.handleSessionIdle("replacement-session")

      state = await stateStore.readOpenCodeState()
      expect(promptCalls).toHaveLength(0)
      expect(state.notificationQueue[0]?.status).toBe("pending")

      await stateStore.updateOpenCodeState((current) => ({
        ...current,
        mainSession: { runtimeSessionId: "replacement-session", status: "active" },
      }))

      await coordinator.handleSessionIdle("replacement-session")

      state = await stateStore.readOpenCodeState()
      expect(promptCalls).toHaveLength(1)
      expect(promptCalls[0]).toMatchObject({
        path: { id: "replacement-session" },
      })
      expect(state.notificationQueue[0]?.status).toBe("done")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("does not duplicate assistant-turn delivery when replacement ready and idle both fire after handoff", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-notification-coordinator-"))
    const stateStore = new StateStore(rootDir, ".chorus")
    const promptCalls: Array<Record<string, unknown>> = []

    try {
      await stateStore.updateOpenCodeState((state) => ({
        ...state,
        mainSession: { runtimeSessionId: "replacement-session", status: "active" },
        notificationQueue: [
          {
            id: "notif-handoff",
            notificationUuid: "notif-handoff",
            kind: "task_verified",
            delivery: "assistant_turn",
            entityUuid: "task-1",
            projectUuid: "proj-1",
            title: "Task verified",
            toastMessage: "Task A verified",
            prompt: "Use chorus_get_unblocked_tasks for project proj-1.",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            attempts: 0,
            status: "pending",
          },
        ],
      }))

      const coordinator = new NotificationCoordinator({
        chorusUrl: "http://chorus.test",
        apiKey: "key",
        enableNotificationHints: true,
        directory: rootDir,
        stateStore,
        chorusClient: { callTool: async () => ({ notifications: [] }) } as never,
        client: {
          session: {
            prompt: async (input: Record<string, unknown>) => {
              promptCalls.push(input)
              return {}
            },
          },
          tui: {
            showToast: async () => true,
          },
        } as never,
        logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      })

      await coordinator.handleSessionReady("replacement-session")
      await coordinator.handleSessionIdle("replacement-session")

      const state = await stateStore.readOpenCodeState()
      expect(promptCalls).toHaveLength(1)
      expect(promptCalls[0]).toMatchObject({
        path: { id: "replacement-session" },
      })
      expect(state.notificationQueue[0]?.status).toBe("done")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

describe("NotificationCoordinator directed-delivery suppression", () => {
  function coordinatorProbe(instanceUuid?: string) {
    const fetched: string[] = []
    const coordinator = new NotificationCoordinator({
      chorusUrl: "http://chorus.test",
      apiKey: "key",
      instanceUuid,
      projectUuids: [],
      enableNotificationHints: false,
      directory: "/tmp/nowhere",
      stateStore: {} as never,
      chorusClient: {
        callTool: async (_name: string, args: Record<string, unknown>) => {
          fetched.push(String(args?.notificationUuid ?? "list"))
          // Empty list: handleSseEvent resolves nothing further — the probe only
          // cares whether the fetch was attempted (i.e. the event survived the gate).
          return { notifications: [] }
        },
      } as never,
      client: { tui: { showToast: async () => true } } as never,
      logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
    })
    return { coordinator, fetched }
  }

  it("ignores an offline-pin event (suppressWake) on every instance", async () => {
    const { coordinator, fetched } = coordinatorProbe("inst-a")
    await coordinator.handleSseEvent({ type: "new_notification", notificationUuid: "n1", suppressWake: true })
    expect(fetched).toHaveLength(0)
  })

  it("ignores an event directed to a different instance", async () => {
    const { coordinator, fetched } = coordinatorProbe("inst-a")
    await coordinator.handleSseEvent({
      type: "new_notification",
      notificationUuid: "n2",
      targetConnectionUuid: "inst-b",
    })
    expect(fetched).toHaveLength(0)
  })

  it("processes an event directed to THIS instance, and un-pinned events", async () => {
    const { coordinator, fetched } = coordinatorProbe("inst-a")
    await coordinator.handleSseEvent({
      type: "new_notification",
      notificationUuid: "n3",
      targetConnectionUuid: "inst-a",
    })
    await coordinator.handleSseEvent({ type: "new_notification", notificationUuid: "n4" })
    expect(fetched.length).toBeGreaterThanOrEqual(2)
  })

  it("suppresses directed events when it has no identity at all (cannot prove target)", async () => {
    const { coordinator, fetched } = coordinatorProbe(undefined)
    await coordinator.handleSseEvent({
      type: "new_notification",
      notificationUuid: "n5",
      targetConnectionUuid: "inst-b",
    })
    expect(fetched).toHaveLength(0)
  })
})
