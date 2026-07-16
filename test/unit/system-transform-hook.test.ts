import { describe, expect, it } from "bun:test"
import {
  PER_TURN_REMINDER,
  PLAN_AGENT_GUIDANCE,
  PROCESS_SAFETY_GUARDRAIL,
  SUBSESSION_WORKFLOW_GUIDANCE,
  createSystemTransformHook,
} from "../../src/hooks/system-transform-hook"
import type { SessionContextRecord } from "../../src/state/state-types"
import { PREFER_NATIVE_FILE_TOOLS_GUIDANCE } from "../../src/util/staging-guidance"

describe("system transform hook", () => {
  it("injects main-session Chorus context and per-turn reminder without legacy guidance", async () => {
    const hook = createSystemTransformHook({
      stateStore: stateStore({ mainSessionId: "session-1" }),
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: ["existing"] }

    await hook({ sessionID: "session-1" } as never, output as never)

    const rendered = output.system.join("\n")
    expect(output.system).toContain("existing")
    expect(rendered).toContain("Chorus Context:")
    expect(output.system).toContain(PER_TURN_REMINDER)
    expect(output.system).not.toContain(PREFER_NATIVE_FILE_TOOLS_GUIDANCE)
    expect(rendered).not.toContain("load the narrowest Chorus skill")
  })

  it("always injects the process-safety guardrail on both main and sub sessions", async () => {
    const hook = createSystemTransformHook({
      stateStore: stateStore({ mainSessionId: "session-1" }),
      isOpenSpecAvailable: async () => false,
    })
    const main = { system: [] as string[] }
    const sub = { system: [] as string[] }

    await hook({ sessionID: "session-1" } as never, main as never) // main session
    await hook({ sessionID: "child-session" } as never, sub as never) // sub session

    expect(main.system).toContain(PROCESS_SAFETY_GUARDRAIL)
    expect(sub.system).toContain(PROCESS_SAFETY_GUARDRAIL) // sub-agents run bash too
  })

  it("does not inject the process-safety guardrail before activation", async () => {
    const hook = createSystemTransformHook({
      stateStore: stateStore({ mainSessionId: "session-1", activated: false }),
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: ["existing"] }

    await hook({ sessionID: "session-1" } as never, output as never)

    expect(output.system).toEqual(["existing"])
  })

  it("does not inject Chorus content before activation", async () => {
    const hook = createSystemTransformHook({
      stateStore: stateStore({ mainSessionId: "session-1", activated: false }),
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: ["existing"] }

    await hook({ sessionID: "session-1" } as never, output as never)

    expect(output.system).toEqual(["existing"])
  })

  it("does not duplicate per-output guidance and injects staging guidance only once", async () => {
    const hook = createSystemTransformHook({
      stagingDir: "/chorus/staging",
      stateStore: stateStore({ mainSessionId: "session-1" }),
      isOpenSpecAvailable: async () => false,
    })
    const firstOutput = { system: [] as string[] }
    const secondOutput = { system: [] as string[] }

    await hook({ sessionID: "session-1" } as never, firstOutput as never)
    await hook({ sessionID: "session-1" } as never, firstOutput as never)
    await hook({ sessionID: "session-1" } as never, secondOutput as never)

    expect(firstOutput.system.filter((line) => line === PER_TURN_REMINDER)).toHaveLength(1)
    expect(firstOutput.system.filter((line) => line.startsWith("Chorus Context:"))).toHaveLength(1)
    expect(firstOutput.system.filter((line) => line.includes("/chorus/staging"))).toHaveLength(1)
    expect(secondOutput.system.some((line) => line.includes("/chorus/staging"))).toBe(false)
  })

  it("hydrates session context before rendering Chorus context", async () => {
    let hydrated = false
    const hook = createSystemTransformHook({
      stateStore: {
        readOpenCodeState: async () => ({
          mainSession: { runtimeSessionId: "session-1" },
          ...(hydrated
            ? {
                sessionContext: {
                  source: "chorus_checkin" as const,
                  runtimeSessionId: "session-1",
                  lastRefreshedAt: "2026-01-01T00:00:00.000Z",
                  projects: [{ uuid: "project-1", name: "OpenCode-Chorus" }],
                },
              }
            : {}),
        }),
        readSharedState: async () => ({ context: {} }),
      },
      ensureSessionContext: async (sessionId: string) => {
        expect(sessionId).toBe("session-1")
        hydrated = true
      },
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: [] as string[] }

    await hook({ sessionID: "session-1" } as never, output as never)

    const rendered = output.system.join("\n")
    expect(rendered).toContain("Chorus project scope: managed")
    expect(rendered).toContain("Project: OpenCode-Chorus (project-1)")
  })

  it("injects managed Chorus context from cached state without undefined metadata", async () => {
    const hook = createSystemTransformHook({
      projectUuids: ["project-1"],
      stateStore: stateStore({
        mainSessionId: "session-1",
        sessionContext: {
          source: "chorus_checkin",
          runtimeSessionId: "session-1",
          lastRefreshedAt: "2026-01-01T00:00:00.000Z",
          agent: { name: "OpenCode", permissions: { idea: ["read", "write"], task: ["read", "write"] } },
          owner: { name: "etnperlong", uuid: "user-1" },
          projects: [{ uuid: "project-1", name: "OpenCode-Chorus" }],
        },
      }),
      isOpenSpecAvailable: async () => true,
    })
    const output = { system: [] as string[] }

    await hook({ sessionID: "session-1" } as never, output as never)

    const rendered = output.system.join("\n")
    expect(rendered).toContain("Chorus Context:")
    expect(rendered).toContain("Chorus project scope: managed")
    expect(rendered).toContain("Project: OpenCode-Chorus (project-1)")
    expect(rendered).toContain("Agent: OpenCode")
    expect(rendered).toContain("Owner: etnperlong (user-1)")
    expect(rendered).toContain("Permissions: idea:read,write")
    expect(rendered).toContain("OpenSpec: available")
    expect(rendered).not.toContain("undefined")
    expect(rendered).not.toContain("null")
  })

  it("falls back to unmanaged scope when no Chorus project can be determined", async () => {
    const hook = createSystemTransformHook({
      stateStore: {
        readOpenCodeState: async () => ({}),
        readSharedState: async () => ({ context: {} }),
      },
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: [] as string[] }

    await hook({ sessionID: "session-1" } as never, output as never)

    const rendered = output.system.join("\n")
    expect(rendered).toContain("Chorus project scope: unmanaged")
    expect(rendered).toContain("do not assume projectUuid")
    expect(rendered).not.toContain("Project: undefined")
  })

  it("injects managed Chorus context from persisted shared workspace binding", async () => {
    const hook = createSystemTransformHook({
      stateStore: {
        readOpenCodeState: async () => ({}),
        readSharedState: async () => ({ context: { projectUuid: "project-1", projectName: "OpenCode-Chorus" } }),
      },
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: [] as string[] }

    await hook({ sessionID: "session-1" } as never, output as never)

    const rendered = output.system.join("\n")
    expect(rendered).toContain("Chorus project scope: managed")
    expect(rendered).toContain("Project: OpenCode-Chorus (project-1)")
  })

  it("reports ambiguous scope for multiple cached session projects", async () => {
    const hook = createSystemTransformHook({
      stateStore: stateStore({
        mainSessionId: "session-1",
        sessionContext: {
          source: "chorus_checkin",
          runtimeSessionId: "session-1",
          lastRefreshedAt: "2026-01-01T00:00:00.000Z",
          projects: [
            { uuid: "project-1", name: "OpenCode-Chorus" },
            { uuid: "project-2", name: "CLIProxyAPI" },
          ],
        },
      }),
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: [] as string[] }

    await hook({ sessionID: "session-1" } as never, output as never)

    const rendered = output.system.join("\n")
    expect(rendered).toContain("Chorus project scope: ambiguous")
    expect(rendered).toContain("Multiple Chorus projects may apply here")
    expect(rendered).toContain("Candidate project count: 2")
  })

  it("omits owner line when owner metadata is missing and tolerates missing session IDs", async () => {
    const hook = createSystemTransformHook({
      projectUuids: ["project-1"],
      stateStore: stateStore({
        mainSessionId: "session-1",
        sessionContext: {
          source: "chorus_checkin",
          runtimeSessionId: "session-1",
          lastRefreshedAt: "2026-01-01T00:00:00.000Z",
          projects: [{ uuid: "project-1", name: "OpenCode-Chorus" }],
        },
      }),
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: [] as string[] }

    await hook({} as never, output as never)

    const rendered = output.system.join("\n")
    expect(rendered).toContain("Chorus project scope: managed")
    expect(rendered).toContain("Project UUID: project-1")
    expect(output.system).toContain(PER_TURN_REMINDER)
    expect(output.system).not.toContain(SUBSESSION_WORKFLOW_GUIDANCE)
    expect(rendered).not.toContain("Owner:")
    expect(rendered).not.toContain("undefined")
  })

  it("injects sub-session workflow guidance without sessionUuid when session differs from main", async () => {
    const hook = createSystemTransformHook({
      stateStore: stateStore({ mainSessionId: "main-session" }),
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: [] as string[] }

    await hook({ sessionID: "child-session" } as never, output as never)

    const rendered = output.system.join("\n")
    expect(output.system).toContain(SUBSESSION_WORKFLOW_GUIDANCE)
    expect(output.system).not.toContain(PER_TURN_REMINDER)
    expect(rendered).not.toContain("sessionUuid")
  })

  it("does not inject sub-session workflow when disabled", async () => {
    const hook = createSystemTransformHook({
      enableSubsessionInjection: false,
      stateStore: stateStore({ mainSessionId: "main-session" }),
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: [] as string[] }

    await hook({ sessionID: "child-session" } as never, output as never)

    expect(output.system).not.toContain(SUBSESSION_WORKFLOW_GUIDANCE)
    expect(output.system).not.toContain(PER_TURN_REMINDER)
  })

  it("treats undefined sessionID as main-session logic", async () => {
    const hook = createSystemTransformHook({
      stateStore: stateStore({ mainSessionId: "main-session" }),
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: [] as string[] }

    await hook({} as never, output as never)

    expect(output.system).toContain(PER_TURN_REMINDER)
    expect(output.system).not.toContain(SUBSESSION_WORKFLOW_GUIDANCE)
  })

  it("injects plan-agent AI-DLC guidance from activeAgent", async () => {
    const hook = createSystemTransformHook({
      stateStore: stateStore({ mainSessionId: "session-1", activeAgent: "plan" }),
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: [] as string[] }

    await hook({ sessionID: "session-1" } as never, output as never)

    expect(output.system).toContain(PLAN_AGENT_GUIDANCE)
  })

  it("does not inject plan-agent guidance when disabled", async () => {
    const hook = createSystemTransformHook({
      enablePlanAgentGuidance: false,
      stateStore: stateStore({ mainSessionId: "session-1", activeAgent: "plan" }),
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: [] as string[] }

    await hook({ sessionID: "session-1" } as never, output as never)

    expect(output.system).not.toContain(PLAN_AGENT_GUIDANCE)
  })

  it("does not inject per-turn reminder when disabled", async () => {
    const hook = createSystemTransformHook({
      enablePerTurnReminder: false,
      stateStore: stateStore({ mainSessionId: "session-1" }),
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: [] as string[] }

    await hook({ sessionID: "session-1" } as never, output as never)

    expect(output.system).not.toContain(PER_TURN_REMINDER)
  })

  it("swallows state read failures and still injects fallback context", async () => {
    const hook = createSystemTransformHook({
      stateStore: {
        readOpenCodeState: async () => {
          throw new Error("state unavailable")
        },
        readSharedState: async () => {
          throw new Error("shared unavailable")
        },
      },
      isOpenSpecAvailable: async () => false,
    })
    const output = { system: [] as string[] }

    await expect(hook({ sessionID: "session-1" } as never, output as never)).resolves.toBeUndefined()

    const rendered = output.system.join("\n")
    expect(output.system).toContain(PER_TURN_REMINDER)
    expect(rendered).toContain("Chorus project scope: unmanaged")
  })
})

type StateStoreInput = {
  mainSessionId?: string
  activeAgent?: string
  activated?: boolean
  sessionContext?: SessionContextRecord
}

function stateStore(input: StateStoreInput) {
  return {
    readOpenCodeState: async () => ({
      mainSession: { runtimeSessionId: input.mainSessionId },
      activeAgent: input.activeAgent,
      activated: input.activated ?? true,
      ...(input.sessionContext ? { sessionContext: input.sessionContext } : {}),
    }),
    readSharedState: async () => ({ context: {} }),
  }
}
