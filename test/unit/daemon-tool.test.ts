import { describe, expect, it } from "bun:test"
import { createDaemonTool } from "../../src/tools/daemon-tool"
import type { CtlAction, EnsureRuntimeResult, RunResult } from "../../src/daemon/daemon-manager"

type FakeManager = {
  calls: string[]
  ensureRuntime(force?: boolean): Promise<EnsureRuntimeResult>
  login(workdir?: string): Promise<RunResult & { workdir: string }>
  ctl(action: CtlAction): Promise<RunResult>
  autostart(enable: boolean): Promise<{ ok: boolean; detail: string }>
}

function fakeManager(overrides: Partial<FakeManager> = {}): FakeManager {
  const manager: FakeManager = {
    calls: [],
    ensureRuntime: async () => {
      manager.calls.push("ensureRuntime")
      return { updated: false, to: "0.13.1@abc1234", runtimeEntry: "/home/dev/.chorus/runtime/chorus-daemon.mjs" }
    },
    login: async (workdir) => {
      manager.calls.push(`login:${workdir ?? ""}`)
      return { code: 0, stdout: "Login successful", stderr: "", workdir: workdir ?? "/home/dev/opencode-auto-work" }
    },
    ctl: async (action) => {
      manager.calls.push(`ctl:${action}`)
      if (action === "status") return { code: 0, stdout: "daemon is running (pid 42)", stderr: "" }
      return { code: 0, stdout: `${action} ok`, stderr: "" }
    },
    autostart: async (enable) => {
      manager.calls.push(`autostart:${enable}`)
      return { ok: true, detail: enable ? "wrote startup entry" : "removed startup entry" }
    },
    ...overrides,
  }
  return manager
}

const ctx = {} as never

describe("chorus_daemon tool", () => {
  it("setup runs the full onboarding chain and reports every step", async () => {
    const manager = fakeManager()
    const definition = createDaemonTool({ manager })

    const result = JSON.parse((await definition.execute({ action: "setup" }, ctx)) as string)

    expect(manager.calls).toEqual(["ensureRuntime", "login:", "autostart:true", "ctl:start", "ctl:status"])
    expect(result.ok).toBe(true)
    expect(result.steps.map((step: { step: string }) => step.step)).toEqual([
      "install runtime",
      "login + unattended defaults",
      "enable start-at-login",
      "start daemon",
      "status",
    ])
    expect(result.note).toContain("127.0.0.1:8638")
  })

  it("setup stops after a failed login and reports the failure", async () => {
    const manager = fakeManager({
      login: async () => ({ code: 1, stdout: "", stderr: "Login failed: API key not found", workdir: "" }),
    })
    const definition = createDaemonTool({ manager })

    const result = JSON.parse((await definition.execute({ action: "setup" }, ctx)) as string)

    expect(result.ok).toBe(false)
    expect(result.steps.at(-1).step).toBe("login + unattended defaults")
    expect(result.steps.at(-1).detail).toContain("API key not found")
    expect(manager.calls).not.toContain("autostart:true")
  })

  it("setup treats an already-running daemon start as success", async () => {
    const manager = fakeManager({
      ctl: async (action) => {
        manager.calls.push(`ctl:${action}`)
        if (action === "start") return { code: 1, stdout: "", stderr: "a daemon is already running (pid 7)" }
        return { code: 0, stdout: "daemon is running (pid 7)", stderr: "" }
      },
    })
    const definition = createDaemonTool({ manager })

    const result = JSON.parse((await definition.execute({ action: "setup" }, ctx)) as string)
    expect(result.ok).toBe(true)
  })

  it("threads the optional workdir into login", async () => {
    const manager = fakeManager()
    const definition = createDaemonTool({ manager })

    await definition.execute({ action: "setup", workdir: "/srv/proj" }, ctx)
    expect(manager.calls).toContain("login:/srv/proj")
  })

  it("lifecycle actions refresh the runtime then delegate to ctl", async () => {
    const manager = fakeManager()
    const definition = createDaemonTool({ manager })

    const result = JSON.parse((await definition.execute({ action: "status" }, ctx)) as string)

    expect(manager.calls).toEqual(["ensureRuntime", "ctl:status"])
    expect(result.ok).toBe(true)
    expect(result.output).toContain("pid 42")
  })

  it("autostart actions toggle via the manager", async () => {
    const manager = fakeManager()
    const definition = createDaemonTool({ manager })

    await definition.execute({ action: "autostart_on" }, ctx)
    await definition.execute({ action: "autostart_off" }, ctx)

    expect(manager.calls).toContain("autostart:true")
    expect(manager.calls).toContain("autostart:false")
  })

  it("returns a structured error instead of throwing", async () => {
    const manager = fakeManager({
      ensureRuntime: async () => {
        throw new Error("Node.js 20+ was not found on PATH")
      },
    })
    const warnings: string[] = []
    const definition = createDaemonTool({
      manager,
      logger: {
        warn: async (message) => {
          warnings.push(message)
        },
      },
    })

    const result = JSON.parse((await definition.execute({ action: "start" }, ctx)) as string)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("Node.js 20+")
    expect(warnings).toEqual(["chorus_daemon action failed"])
  })
})
