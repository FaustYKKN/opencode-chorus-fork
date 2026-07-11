import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { restorePluginHookMocks, setPluginHookMockRuntime } from "./plugin-hooks-mocks"
import { createPlugin } from "../../src/index"
import { PLAN_AGENT_GUIDANCE } from "../../src/hooks/system-transform-hook"
import { resolveStatePaths } from "../../src/state/paths"
import { StateStore } from "../../src/state/state-store"
const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = []
const sessionCalls: Array<{ name: string; args: Record<string, unknown> }> = []
const logCalls: Array<{ level: string; message?: string; extra?: Record<string, unknown> }> = []
const toastCalls: Array<{ title?: string; message?: string; variant?: string; duration?: number }> = []
let getCommentsResponse: unknown = { comments: [] }
let getProposalResponse: unknown = {}
let getTaskResponse: unknown = {}
let sessionStatusResponse: Record<string, unknown> = {}
const chorusSkillsDir = fileURLToPath(new URL("../../skills/", import.meta.url))
let configDir = ""
let previousConfigDir: string | undefined
let previousChorusApiKey: string | undefined
let previousXdgStateHome: string | undefined
let listToolsCalls = 0
let listToolsError: Error | undefined
let checkinError: Error | undefined
let listenerConnectCalls = 0
let listenerDisconnectCalls = 0

setPluginHookMockRuntime({
  async listTools() {
    listToolsCalls += 1
    if (listToolsError) throw listToolsError
    return [
      {
        name: "chorus_checkin",
        description: "Check in to Chorus",
        inputSchema: { type: "object", properties: {} },
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown> = {}) {
    toolCalls.push({ name, args })
    if (name === "chorus_checkin") {
      if (checkinError) throw checkinError
      return {
        agent: {
          uuid: "agent-1",
          name: "OpenCode",
          permissions: { task: ["read", "write"] },
          owner: { uuid: "user-1", name: "etnperlong" },
        },
        ideaTracker: {
          "project-1": {
            name: "OpenCode-Chorus",
            ideas: [{ taskCount: 2, pendingProposalCount: 1 }],
          },
        },
        notifications: [{ uuid: "notification-1" }],
      }
    }
    if (name === "chorus_get_comments") return getCommentsResponse
    if (name === "chorus_get_proposal") return getProposalResponse
    if (name === "chorus_get_task") return getTaskResponse
    return {}
  },

  async disconnectMcp() {},

  getSseStatus() {
    return "disconnected"
  },

  async connectSse() {
    listenerConnectCalls += 1
  },

  disconnectSse() {
    listenerDisconnectCalls += 1
  },
})

// Restore all module mocks after this file so subsequent test files (e.g. mcp-client.test.ts)
// receive the real module implementations instead of these plugin-scoped mocks.
afterAll(() => restorePluginHookMocks())

describe("plugin hooks", () => {
  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "opencode-config-"))
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    previousChorusApiKey = process.env.CHORUS_API_KEY
    previousXdgStateHome = process.env.XDG_STATE_HOME
    process.env.OPENCODE_CONFIG_DIR = configDir
    process.env.XDG_STATE_HOME = join(configDir, "state")
    delete process.env.CHORUS_API_KEY
  })

  afterEach(async () => {
    toolCalls.length = 0
    sessionCalls.length = 0
    logCalls.length = 0
    toastCalls.length = 0
    getCommentsResponse = { comments: [] }
    getProposalResponse = {}
    getTaskResponse = {}
    sessionStatusResponse = {}
    listToolsCalls = 0
    listToolsError = undefined
    checkinError = undefined
    listenerConnectCalls = 0
    listenerDisconnectCalls = 0
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    if (previousChorusApiKey === undefined) delete process.env.CHORUS_API_KEY
    else process.env.CHORUS_API_KEY = previousChorusApiKey
    if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousXdgStateHome
    await rm(configDir, { recursive: true, force: true })
  })

  it("does not check in or start the main Chorus session before Chorus tool use", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })

      await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-1" } } } } as never)

      expect(toolCalls.map((call) => call.name)).not.toContain("chorus_checkin")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("auto-activates Chorus on session startup when workspace context is already bound", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const stateStore = new StateStore({ projectRoot: rootDir, worktree: rootDir })
      await stateStore.init()
      await stateStore.updateSharedState((state) => ({
        ...state,
        context: { projectUuid: "project-1", projectName: "OpenCode-Chorus" },
      }))

      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })

      await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-bound" } } } } as never)

      expect(toolCalls.map((call) => call.name)).toContain("chorus_checkin")
      expect(listToolsCalls).toBe(1)
      expect(listenerConnectCalls).toBe(1)
      expect(toastCalls).toContainEqual(
        expect.objectContaining({
          title: "Chorus connected",
          variant: "success",
        }),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("does not create .chorus state on plugin creation alone", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })

      await expect(access(join(rootDir, ".chorus"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("does not surface Chorus context on session.created or chat.params before tool activation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableSessionContextSummary: true,
      })

      await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-context" } } } } as never)

      // No context log message should appear on session.created
      expect(logCalls.some((call) => call.message?.startsWith("Chorus context:"))).toBe(false)

      await plugin["chat.params"]?.(
        { sessionID: "session-context", agent: "build", model: {} as never, provider: {} as never, message: {} as never },
        { temperature: 1, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} },
      )

      expect(logCalls.some((call) => call.message?.startsWith("Chorus context:"))).toBe(false)

      await plugin["chat.params"]?.(
        { sessionID: "session-context", agent: "build", model: {} as never, provider: {} as never, message: {} as never },
        { temperature: 1, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} },
      )
      expect(logCalls.filter((call) => call.message?.startsWith("Chorus context:"))).toHaveLength(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("keeps compact context runtime-only without surfacing it when disabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableSessionContextSummary: false,
      })

      await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-context" } } } } as never)

      // Trigger hydration — context is not logged when disabled
      await plugin["chat.params"]?.(
        { sessionID: "session-context", agent: "build", model: {} as never, provider: {} as never, message: {} as never },
        { temperature: 1, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} },
      )

      expect(logCalls.some((call) => call.message?.startsWith("Chorus context:"))).toBe(false)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("bridges chat.params agent into runtime state", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))
    const originalSetActiveAgent = StateStore.prototype.setActiveAgent
    const activeAgents: string[] = []
    StateStore.prototype.setActiveAgent = function setActiveAgent(agent: string) {
      activeAgents.push(agent)
      return originalSetActiveAgent.call(this, agent)
    }

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })

      await plugin["chat.params"]?.(
        { sessionID: "session-context", agent: "plan", model: {} as never, provider: {} as never, message: {} as never },
        { temperature: 1, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} },
      )

      expect(activeAgents).toContain("plan")
    } finally {
      StateStore.prototype.setActiveAgent = originalSetActiveAgent
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("skips system prompt transform before tool activation even when chat.message bridges agent", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })
      const output = { system: [] as string[] }

      await plugin["chat.message"]?.(
        { sessionID: "session-plan", agent: "plan", model: {} as never },
        { message: {} as never, parts: [] },
      )
      await plugin["experimental.chat.system.transform"]?.({ sessionID: "session-plan", model: {} as never }, output as never)

      expect(output.system).not.toContain(PLAN_AGENT_GUIDANCE)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("reviews submitted proposals using proposalUuid from args when output omits it", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableProposalReviewer: true,
        reviewerWaitTimeoutMs: 50,
        reviewerPollIntervalMs: 1,
      })
      getCommentsResponse = { comments: [{ content: "review\nReview-Job-ID: review-session-1\nVERDICT: PASS" }] }
      const output: { title: string; output: string; metadata: unknown } = {
        title: "",
        output: JSON.stringify({ submitted: true }),
        metadata: { preserved: true },
      }

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_pm_submit_proposal",
          args: { proposalUuid: "proposal-from-args" },
          sessionID: "session-1",
        } as never,
        output as never,
      )

      expect(toolCalls.map((call) => call.name)).not.toContain("chorus_add_comment")
      expect(sessionCalls).toContainEqual({
        name: "create",
        args: expect.objectContaining({
          responseStyle: "data",
          body: expect.objectContaining({
            parentID: "session-1",
            title: "Chorus proposal review: proposal-from-args (@proposal-reviewer subagent)",
          }),
        }),
      })
      expect(sessionCalls).toContainEqual({
        name: "promptAsync",
        args: expect.objectContaining({
          body: expect.objectContaining({
            agent: "proposal-reviewer",
            parts: [{ type: "text", text: expect.stringContaining("Review-Job-ID: review-session-1") }],
          }),
        }),
      })
      expect(output.title).toBe("Chorus proposal review")
      expect(output.metadata).toEqual({
        preserved: true,
        sessionId: "review-session-1",
        taskId: "review-session-1",
        agent: "proposal-reviewer",
        reviewStatus: "completed",
        verdict: "PASS",
        reviewJobId: "review-session-1",
        reviewRound: 1,
        reviewMaxRounds: 3,
        reviewGateOutputMode: "summary",
        reviewNextAction: "Proceed to proposal approval.",
      })
      expect(output.output).toContain('"reviewer"')
      expect(output.output).toContain('"verdict": "PASS"')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("reviews submitted proposals from native Chorus MCP tool names", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableProposalReviewer: true,
        reviewerWaitTimeoutMs: 50,
        reviewerPollIntervalMs: 1,
      })
      getCommentsResponse = { comments: [{ content: "review\nReview-Job-ID: review-session-1\nVERDICT: PASS" }] }

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_chorus_pm_submit_proposal",
          args: { proposalUuid: "native-proposal" },
          sessionID: "session-1",
        } as never,
        { output: JSON.stringify({ submitted: true }) } as never,
      )

      expect(sessionCalls).toContainEqual({
        name: "promptAsync",
        args: expect.objectContaining({
          body: expect.objectContaining({ agent: "proposal-reviewer" }),
        }),
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("reviews submitted tasks using a task reviewer session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableTaskReviewer: true,
        reviewerWaitTimeoutMs: 50,
        reviewerPollIntervalMs: 1,
      })
      getCommentsResponse = { comments: [{ content: "review\nReview-Job-ID: review-session-1\nVERDICT: FAIL" }] }
      const output: { title: string; output: string; metadata: unknown } = {
        title: "",
        output: JSON.stringify({ submitted: true }),
        metadata: "not-an-object",
      }

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_submit_for_verify",
          args: { taskUuid: "task-from-args" },
          sessionID: "session-1",
        } as never,
        output as never,
      )

      expect(toolCalls.map((call) => call.name)).not.toContain("chorus_add_comment")
      expect(sessionCalls).toContainEqual({
        name: "create",
        args: expect.objectContaining({
          body: expect.objectContaining({
            parentID: "session-1",
            title: "Chorus task review: task-from-args (@task-reviewer subagent)",
          }),
        }),
      })
      expect(sessionCalls).toContainEqual({
        name: "promptAsync",
        args: expect.objectContaining({
          body: expect.objectContaining({ agent: "task-reviewer" }),
        }),
      })
      expect(output.title).toBe("Chorus task review")
      expect(output.metadata).toEqual({
        sessionId: "review-session-1",
        taskId: "review-session-1",
        agent: "task-reviewer",
        reviewStatus: "completed",
        verdict: "FAIL",
        reviewJobId: "review-session-1",
        reviewRound: 1,
        reviewMaxRounds: 3,
        reviewGateOutputMode: "summary",
        reviewNextAction: "Fix reviewer BLOCKERs, then resubmit for verification.",
      })
      expect(output.output).toContain('"reviewer"')
      expect(output.output).toContain('"verdict": "FAIL"')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("shows reviewer toasts using target names and round context", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableTaskReviewer: true,
        reviewerWaitTimeoutMs: 50,
        reviewerPollIntervalMs: 1,
      })
      getTaskResponse = { title: "Implement reviewer toast" }
      getCommentsResponse = { comments: [{ content: "review\nReview-Job-ID: review-session-1\nVERDICT: PASS" }] }

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_submit_for_verify",
          args: { taskUuid: "task-toast" },
          sessionID: "session-1",
        } as never,
        { title: "", output: JSON.stringify({ submitted: true }), metadata: {} } as never,
      )

      expect(toastCalls).toContainEqual({
        title: "Reviewing Implement reviewer toast (round 1/3)",
        message: "Chorus task reviewer is running...",
        variant: "info",
        duration: 50,
      })
      expect(toastCalls).toContainEqual({
        title: "Reviewed Implement reviewer toast (round 1/3)",
        message: "PASS",
        variant: "success",
        duration: 4000,
      })
      expect(JSON.stringify(toastCalls)).not.toContain("review-session-1")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("annotates reviewer timeouts on submitted tasks", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableTaskReviewer: true,
        reviewerWaitTimeoutMs: 5,
        reviewerPollIntervalMs: 1,
      })
      getCommentsResponse = { comments: [{ content: "review without verdict" }] }
      const output: { title: string; output: string; metadata: unknown } = {
        title: "",
        output: JSON.stringify({ submitted: true }),
        metadata: { preserved: true },
      }

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_submit_for_verify",
          args: { taskUuid: "task-timeout" },
          sessionID: "session-1",
        } as never,
        output as never,
      )

      expect(output.metadata).toEqual({
        preserved: true,
        sessionId: "review-session-1",
        taskId: "review-session-1",
        agent: "task-reviewer",
        reviewStatus: "timeout",
        reviewJobId: "review-session-1",
        reviewRound: 1,
        reviewMaxRounds: 3,
        reviewGateOutputMode: "summary",
        reviewNextAction: "Inspect reviewer session review-session-1 or task comments, then retry the reviewer gate or escalate.",
      })
      expect(output.output).toContain("Reviewer did not finish before timeout")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("keeps reviewer gates in running state when the child reviewer session is still busy", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableTaskReviewer: true,
        reviewerWaitTimeoutMs: 1,
        reviewerPollIntervalMs: 1,
      })
      getCommentsResponse = { comments: [] }
      sessionStatusResponse = { "review-session-1": { type: "busy" } }
      const output: { title: string; output: string; metadata: unknown } = {
        title: "",
        output: JSON.stringify({ submitted: true }),
        metadata: { preserved: true },
      }

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_submit_for_verify",
          args: { taskUuid: "task-still-running" },
          sessionID: "session-1",
        } as never,
        output as never,
      )

      expect(output.metadata).toEqual({
        preserved: true,
        sessionId: "review-session-1",
        taskId: "review-session-1",
        agent: "task-reviewer",
        reviewStatus: "running",
        reviewJobId: "review-session-1",
        reviewRound: 1,
        reviewMaxRounds: 3,
        reviewGateOutputMode: "summary",
        reviewNextAction: "Wait for reviewer session review-session-1 to finish before retrying this gate.",
      })
      expect(output.output).toContain("still running after the wait window")

      const state = await readPluginState(rootDir)
      expect(state.reviews["task:task-still-running"]).toMatchObject({
        status: "reviewing",
        lastReviewJobId: "review-session-1",
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("completes the gate when a busy reviewer posts its verdict during the extended wait window", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableTaskReviewer: true,
        reviewerWaitTimeoutMs: 20,
        reviewerPollIntervalMs: 1,
      })
      getCommentsResponse = { comments: [] }
      sessionStatusResponse = { "review-session-1": { type: "busy" } }
      const output: { title: string; output: string; metadata: unknown } = {
        title: "",
        output: JSON.stringify({ submitted: true }),
        metadata: { preserved: true },
      }

      const timer = setTimeout(() => {
        getCommentsResponse = {
          comments: [{ content: "review\nReview-Job-ID: review-session-1\nVERDICT: PASS" }],
        }
      }, 25)

      try {
        await plugin["tool.execute.after"]?.(
          {
            tool: "chorus_submit_for_verify",
            args: { taskUuid: "task-delayed-reviewer" },
            sessionID: "session-1",
          } as never,
          output as never,
        )
      } finally {
        clearTimeout(timer)
      }

      expect(output.metadata).toEqual({
        preserved: true,
        sessionId: "review-session-1",
        taskId: "review-session-1",
        agent: "task-reviewer",
        reviewStatus: "completed",
        verdict: "PASS",
        reviewJobId: "review-session-1",
        reviewRound: 1,
        reviewMaxRounds: 3,
        reviewGateOutputMode: "summary",
        reviewNextAction: "Proceed to admin verification.",
      })
      expect(output.output).toContain('"verdict": "PASS"')
      expect(sessionCalls).toContainEqual({
        name: "status",
        args: expect.objectContaining({
          query: { directory: rootDir },
          responseStyle: "data",
          throwOnError: true,
        }),
      })

      const state = await readPluginState(rootDir)
      expect(state.reviews["task:task-delayed-reviewer"]).toMatchObject({
        status: "approved",
        lastVerdict: "PASS",
        lastReviewJobId: "review-session-1",
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("reviews submitted tasks from native Chorus MCP tool names", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableTaskReviewer: true,
        reviewerWaitTimeoutMs: 50,
        reviewerPollIntervalMs: 1,
      })
      getCommentsResponse = { comments: [{ content: "review\nReview-Job-ID: review-session-1\nVERDICT: PASS" }] }

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_chorus_submit_for_verify",
          args: { taskUuid: "native-task" },
          sessionID: "session-1",
        } as never,
        { output: JSON.stringify({ submitted: true }) } as never,
      )

      expect(sessionCalls).toContainEqual({
        name: "promptAsync",
        args: expect.objectContaining({
          body: expect.objectContaining({ agent: "task-reviewer" }),
        }),
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("annotates escalated reviewer gates without dispatching another reviewer", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableTaskReviewer: true,
        maxTaskReviewRounds: 1,
      })
      const store = new StateStore({ projectRoot: rootDir, worktree: rootDir, stateMode: "global" })
      await store.updateOpenCodeState((state) => ({
        ...state,
        reviews: {
          ...state.reviews,
          "task:task-escalated": {
            currentRound: 1,
            maxRounds: 1,
            status: "changes-requested",
            lastVerdict: "FAIL",
            lastReviewJobId: "review-session-previous",
            blockersSnapshot: [],
          },
        },
      }))

      const output: { title: string; output: string; metadata: unknown } = {
        title: "",
        output: JSON.stringify({ submitted: true }),
        metadata: {},
      }

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_submit_for_verify",
          args: { taskUuid: "task-escalated" },
          sessionID: "session-1",
        } as never,
        output as never,
      )

      expect(sessionCalls.map((call) => call.name)).not.toContain("create")
      expect(output.metadata).toMatchObject({
        reviewStatus: "escalated",
        reviewJobId: "review-session-previous",
        reviewRound: 2,
        reviewMaxRounds: 1,
        reviewNextAction: "Escalate for human review before retrying this gate.",
      })
      expect(JSON.parse(output.output).reviewer.status).toBe("escalated")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("persists task review verdicts from reviewer comments", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableTaskReviewer: true,
        reviewerWaitTimeoutMs: 50,
        reviewerPollIntervalMs: 1,
      })
      getCommentsResponse = { comments: [{ content: "review\nReview-Job-ID: review-session-1\nVERDICT: PASS" }] }

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_submit_for_verify",
          args: { taskUuid: "task-1" },
          sessionID: "session-1",
        } as never,
        { output: JSON.stringify({ submitted: true }) } as never,
      )
      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_add_comment",
          args: { targetType: "task", targetUuid: "task-1", content: "review\nVERDICT: FAIL" },
          sessionID: "review-session-1",
        } as never,
        { output: JSON.stringify({}) } as never,
      )

      const state = await readPluginState(rootDir)
      expect(state.reviews["task:task-1"].lastVerdict).toBe("FAIL")
      expect(state.reviews["task:task-1"].status).toBe("changes-requested")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("ignores stale verdict comments from non-current sessions during active review", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableTaskReviewer: true,
        reviewerWaitTimeoutMs: 1,
        reviewerPollIntervalMs: 1,
      })
      getCommentsResponse = { comments: [] }

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_submit_for_verify",
          args: { taskUuid: "task-active" },
          sessionID: "session-1",
        } as never,
        { output: JSON.stringify({ submitted: true }) } as never,
      )
      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_add_comment",
          args: { targetType: "task", targetUuid: "task-active", content: "stale\nVERDICT: FAIL" },
          sessionID: "other-session",
        } as never,
        { output: JSON.stringify({}) } as never,
      )

      const state = await readPluginState(rootDir)
      expect(state.reviews["task:task-active"].status).toBe("timed-out")
      expect(state.reviews["task:task-active"].lastVerdict).toBeUndefined()
      expect(state.reviews["task:task-active"].lastReviewJobId).toBe("review-session-1")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("ignores late verdict comments from old reviewer sessions after current review completes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
        enableTaskReviewer: true,
        reviewerWaitTimeoutMs: 50,
        reviewerPollIntervalMs: 1,
      })
      getCommentsResponse = { comments: [{ content: "review\nReview-Job-ID: review-session-1\nVERDICT: PASS" }] }

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_submit_for_verify",
          args: { taskUuid: "task-completed" },
          sessionID: "session-1",
        } as never,
        { output: JSON.stringify({ submitted: true }) } as never,
      )
      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_add_comment",
          args: { targetType: "task", targetUuid: "task-completed", content: "late\nVERDICT: FAIL" },
          sessionID: "old-review-session",
        } as never,
        { output: JSON.stringify({}) } as never,
      )

      const state = await readPluginState(rootDir)
      expect(state.reviews["task:task-completed"].status).toBe("approved")
      expect(state.reviews["task:task-completed"].lastVerdict).toBe("PASS")
      expect(state.reviews["task:task-completed"].lastReviewJobId).toBe("review-session-1")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("ignores verdict comments while an active review has no current job id", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })
      const statePath = pluginStatePath(rootDir)
      const store = new StateStore({ projectRoot: rootDir, worktree: rootDir, stateMode: "global" })
      await store.updateOpenCodeState((state) => ({
        ...state,
        reviews: {
          ...state.reviews,
          "task:task-without-job": {
            currentRound: 1,
            maxRounds: 3,
            status: "reviewing",
            blockersSnapshot: [],
          },
        },
      }))

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_add_comment",
          args: { targetType: "task", targetUuid: "task-without-job", content: "review\nVERDICT: FAIL" },
          sessionID: "some-session",
        } as never,
        { output: JSON.stringify({}) } as never,
      )

      const nextState = JSON.parse(await readFile(statePath, "utf8"))
      expect(nextState.reviews["task:task-without-job"].status).toBe("reviewing")
      expect(nextState.reviews["task:task-without-job"].lastVerdict).toBeUndefined()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("persists review verdicts from native Chorus MCP comment tool names", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_chorus_add_comment",
          args: { targetType: "proposal", targetUuid: "proposal-1", content: "review\nVERDICT: PASS" },
          sessionID: "session-1",
        } as never,
        { output: JSON.stringify({}) } as never,
      )

      const state = await readPluginState(rootDir)
      expect(state.reviews["proposal:proposal-1"].lastVerdict).toBe("PASS")
      expect(state.reviews["proposal:proposal-1"].status).toBe("approved")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("ignores non-verdict reviewer comments", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })

      await plugin["tool.execute.after"]?.(
        {
          tool: "chorus_add_comment",
          args: { targetType: "task", targetUuid: "task-1", content: "review without verdict" },
          sessionID: "session-1",
        } as never,
        { output: JSON.stringify({}) } as never,
      )

      await expect(access(pluginStatePath(rootDir))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("registers reviewer agents with the expected OpenCode config", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })
      const config: Record<string, unknown> = {}

      await plugin.config?.(config as never)

      expect(config.skills).toEqual({
        paths: [chorusSkillsDir],
      })

      const agents = config.agent as Record<string, Record<string, unknown>>
      const proposalReviewer = agents["proposal-reviewer"]
      const taskReviewer = agents["task-reviewer"]

      expect(Object.keys(agents)).toEqual(["proposal-reviewer", "task-reviewer"])
      expect(proposalReviewer).toBeDefined()
      expect(taskReviewer).toBeDefined()
      expect(proposalReviewer).toMatchObject({
        mode: "subagent",
        maxSteps: 100,
        permission: {
          edit: "deny",
          bash: "deny",
        },
      })
      expect(proposalReviewer?.prompt).toContain("Hard stop rule")
      expect(taskReviewer).toMatchObject({
        mode: "subagent",
        maxSteps: 100,
        permission: {
          edit: "deny",
          bash: "allow",
        },
      })
      expect(taskReviewer?.prompt).toContain("targeted re-verification")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("returns config-only fallback behavior when runtime Chorus config is missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {})
      const config: Record<string, unknown> = {}

      expect(plugin.config).toBeFunction()
      expect(plugin.event).toBeUndefined()
      expect(plugin.tool).toBeUndefined()
      expect(plugin["permission.ask"]).toBeUndefined()
      expect(plugin["tool.execute.after"]).toBeUndefined()
      expect(plugin["experimental.chat.system.transform"]).toBeUndefined()

      await plugin.config?.(config as never)

      expect(config.skills).toEqual({
        paths: [chorusSkillsDir],
      })
      expect(config.mcp).toBeUndefined()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("does not inject a remote Chorus MCP server when runtime config is available", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })
      const config: Record<string, unknown> = {
        mcp: {
          context7: {
            type: "remote",
            url: "https://mcp.context7.com/mcp",
            enabled: true,
          },
        },
      }

      await plugin.config?.(config as never)

      expect(config.mcp).toEqual({
        context7: {
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          enabled: true,
        },
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("does not inject a native Chorus MCP server when runtime config is missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {})
      const config: Record<string, unknown> = {
        mcp: {
          context7: {
            type: "remote",
            url: "https://mcp.context7.com/mcp",
            enabled: true,
          },
        },
      }

      await plugin.config?.(config as never)

      expect(config.mcp).toEqual({
        context7: {
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          enabled: true,
        },
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("preserves an existing user-provided chorus MCP entry without adding one", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })
      const config: Record<string, unknown> = {
        mcp: {
          chorus: {
            type: "remote",
            url: "https://custom.example/mcp",
            enabled: false,
          },
        },
      }

      await plugin.config?.(config as never)

      expect(config.mcp).toEqual({
        chorus: {
          type: "remote",
          url: "https://custom.example/mcp",
          enabled: false,
        },
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("rethrows non-missing config load failures", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))
    const configPath = join(configDir, "chorus.json")

    try {
      await writeFile(configPath, "{")

      await expect(createPlugin(createContext(rootDir), {})).rejects.toMatchObject({
        name: "InvalidChorusConfigError",
        configPath,
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("returns lazy bridge tools when valid Chorus config is present", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })

      expect(plugin.config).toBeFunction()
      expect(plugin.event).toBeFunction()
      expect(plugin["permission.ask"]).toBeFunction()
      expect(plugin["tool.execute.after"]).toBeFunction()
      expect(plugin["experimental.chat.system.transform"]).toBeFunction()
      expect(plugin["chat.params"]).toBeFunction()
      expect(Object.keys(plugin.tool ?? {}).sort()).toEqual([
        "chorus_daemon",
        "chorus_tool_execute",
        "chorus_tool_get",
        "chorus_tools",
        "chorus_workspace_context",
      ])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("injects concise system guidance and one-time staging directory guidance", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })
      await plugin.tool?.chorus_tools?.execute({}, createToolContext("build", "session-guidance", rootDir))
      const output = { system: ["existing guidance"] }

      await plugin["experimental.chat.system.transform"]?.({ sessionID: "session-guidance" } as never, output as never)

      expect(output.system).toContain("existing guidance")
      expect(output.system.some((line) => line.includes("[Chorus Plugin Active]"))).toBe(true)
      expect(output.system.some((line) => line.includes("Prefer OpenCode's native `write` and `edit` tools"))).toBe(false)
      expect(output.system.some((line) => line.includes("Chorus staging directory"))).toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("does NOT refresh the lazy bridge tool index on session startup — readiness is deferred", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })

      await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-lazy" } } } } as never)

      expect(listToolsCalls).toBe(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("activates session context and listener on first Chorus tool use", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })

      await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-native" } } } } as never)
      expect(listToolsCalls).toBe(0)
      expect(toastCalls.some((t) => t.title === "Chorus connected")).toBe(false)

      await plugin.tool?.chorus_tools?.execute({}, createToolContext("build", "session-native", rootDir))

      expect(toolCalls.filter((call) => call.name === "chorus_checkin")).toHaveLength(1)
      expect(listToolsCalls).toBe(1)
      expect(toastCalls.some((t) => t.title === "Chorus connected")).toBe(true)
      expect(listenerConnectCalls).toBe(1)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("does not repeat activation on subsequent Chorus tool calls in the same session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })

      await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-dedup" } } } } as never)

      await plugin.tool?.chorus_tools?.execute({}, createToolContext("build", "session-dedup", rootDir))
      await plugin.tool?.chorus_tools?.execute({}, createToolContext("build", "session-dedup", rootDir))
      await plugin.tool?.chorus_tools?.execute({}, createToolContext("build", "session-dedup", rootDir))

      expect(toolCalls.filter((call) => call.name === "chorus_checkin")).toHaveLength(1)
      expect(listToolsCalls).toBe(1)
      expect(toastCalls.filter((t) => t.title === "Chorus connected")).toHaveLength(1)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("restarts the notification listener only after replacement main-session readiness", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })

      expect(listenerConnectCalls).toBe(0)
      expect(listenerDisconnectCalls).toBe(0)

      await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-old" } } } } as never)
      await plugin.tool?.chorus_tools?.execute({}, createToolContext("build", "session-old", rootDir))

      expect(listenerConnectCalls).toBe(1)

      await plugin.event?.({ event: { type: "session.deleted", properties: { info: { id: "session-old" } } } } as never)

      expect(listenerDisconnectCalls).toBe(1)
      expect(listenerConnectCalls).toBe(1)

      await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-new" } } } } as never)
      await plugin.event?.({ event: { type: "session.idle", properties: { info: { id: "session-new" } } } } as never)

      expect(listenerConnectCalls).toBe(1)
      expect(listenerDisconnectCalls).toBe(1)

      await plugin.tool?.chorus_tools?.execute({}, createToolContext("build", "session-new", rootDir))

      expect(listenerConnectCalls).toBe(2)
      expect(listenerDisconnectCalls).toBe(1)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("surfaces activation failure from first Chorus tool use", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))
    checkinError = new Error("Chorus unavailable")

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })

      // session.created must not fail because hydration is deferred until chat.params
      await expect(
        plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-1" } } } } as never),
      ).resolves.toBeUndefined()

      await expect(
        plugin.tool?.chorus_tools?.execute({}, createToolContext("build", "session-1", rootDir)),
      ).rejects.toThrow("Chorus unavailable")
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("registers bundled Chorus skills without overwriting existing skill paths", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })
      const config: Record<string, unknown> = {
        skills: { paths: ["/tmp/custom-skills"] },
      }

      await plugin.config?.(config as never)

      expect(config.skills).toEqual({
        paths: ["/tmp/custom-skills", chorusSkillsDir],
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("does not duplicate the bundled Chorus skills path", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })
      const config: Record<string, unknown> = {
        skills: { paths: [chorusSkillsDir] },
      }

      await plugin.config?.(config as never)

      const paths = (config.skills as { paths: string[] }).paths
      expect(paths.filter((entry) => entry === chorusSkillsDir)).toHaveLength(1)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("does not duplicate the bundled Chorus skills path when an existing entry omits the trailing separator", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      const plugin = await createPlugin(createContext(rootDir), {
        chorusUrl: "http://localhost:8637",
        apiKey: "test-key",
      })
      const config: Record<string, unknown> = {
        skills: { paths: [chorusSkillsDir.replace(/\/$/, "")] },
      }

      await plugin.config?.(config as never)

      expect((config.skills as { paths: string[] }).paths).toEqual([chorusSkillsDir.replace(/\/$/, "")])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it("warns when apiKey is loaded from chorus.json", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "opencode-chorus-plugin-"))

    try {
      await writeFile(
        join(configDir, "chorus.json"),
        JSON.stringify({ chorusUrl: "http://localhost:8637", apiKey: "file-key" }),
      )

      await createPlugin(createContext(rootDir), {})

      expect(logCalls).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "Chorus API key was loaded from chorus.json; prefer CHORUS_API_KEY for secrets.",
        }),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

function createContext(directory: string) {
  return {
    directory,
    worktree: directory,
    client: {
      app: {
        log: async (input?: { body?: { level?: string; message?: string; extra?: Record<string, unknown> } }) => {
          logCalls.push({
            level: input?.body?.level ?? "",
            message: input?.body?.message,
            extra: input?.body?.extra,
          })
        },
      },
      tui: {
        showToast: async (input: { body?: { title?: string; message?: string; variant?: string; duration?: number } }) => {
          toastCalls.push(input.body ?? {})
        },
      },
      session: {
        create: async (args: Record<string, unknown>) => {
          sessionCalls.push({ name: "create", args })
          return { id: `review-session-${sessionCalls.length}` }
        },
        promptAsync: async (args: Record<string, unknown>) => {
          sessionCalls.push({ name: "promptAsync", args })
        },
        status: async (args: Record<string, unknown>) => {
          sessionCalls.push({ name: "status", args })
          return { data: sessionStatusResponse }
        },
      },
    },
  } as never
}

function pluginStatePath(rootDir: string): string {
  return resolveStatePaths({ projectRoot: rootDir, worktree: rootDir }).stateFile
}

async function readPluginState(rootDir: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(pluginStatePath(rootDir), "utf8"))
}

function createToolContext(agent = "build", sessionID = "session-1", directory = "/tmp/project") {
  return {
    sessionID,
    messageID: "message-1",
    agent,
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: (() => {}) as never,
  }
}
