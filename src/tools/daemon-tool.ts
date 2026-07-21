import { tool, type ToolDefinition, type ToolResult } from "@opencode-ai/plugin"
import type { CtlAction, DaemonManager } from "../daemon/daemon-manager"

// Local-only management of the Chorus daemon that ships INSIDE this plugin
// package (daemon/chorus-daemon.mjs). `setup` is the one-shot onboarding verb:
// after it succeeds the machine keeps executing platform-dispatched tasks with
// OpenCode closed — the daemon is an independent resident process, the plugin
// only installs and drives it.

type DaemonToolAction =
  | "setup"
  | "start"
  | "stop"
  | "restart"
  | "status"
  | "logs"
  | "autostart_on"
  | "autostart_off"

type DaemonToolManager = Pick<DaemonManager, "ensureRuntime" | "login" | "ctl" | "autostart">

type CreateDaemonToolOptions = {
  manager: DaemonToolManager
  logger?: { warn(message: string, data?: Record<string, unknown>): Promise<void> }
}

type SetupStep = { step: string; ok: boolean; detail: string }

export function createDaemonTool(options: CreateDaemonToolOptions): ToolDefinition {
  return tool({
    description:
      "Manage this machine's Chorus daemon (the unattended wake service bundled inside this plugin; requires Node 20+ on PATH). " +
      "当用户说“开启无人值守”“无人值守模式”“后台唤醒”“开机自启接单”或类似表述时，调用本工具并传 action=setup。 " +
      "Use action=setup once to enable unattended mode: it installs the daemon runtime, logs it in with this plugin's Chorus credentials, " +
      "enables start-at-login, and starts it now — afterwards the platform can wake OpenCode on this machine even with every window closed. " +
      "Other actions control the running daemon: start / stop / restart / status / logs, and autostart_on / autostart_off toggle start-at-login.",
    args: {
      action: tool.schema
        .enum(["setup", "start", "stop", "restart", "status", "logs", "autostart_on", "autostart_off"])
        .describe("setup = one-shot unattended onboarding; the rest are daemon lifecycle / autostart controls."),
      workdir: tool.schema
        .string()
        .optional()
        .describe(
          "setup only: absolute path of the directory the daemon serves (added to the whitelist and created if missing). " +
            "Default: D:\\opencode-auto-work on Windows when D: exists, otherwise ~/opencode-auto-work.",
        ),
    },
    async execute(args) {
      const action = args.action as DaemonToolAction
      try {
        if (action === "setup") return await runSetup(options.manager, args.workdir)
        if (action === "autostart_on" || action === "autostart_off") {
          const enable = action === "autostart_on"
          await options.manager.ensureRuntime()
          const result = await options.manager.autostart(enable)
          return formatToolResult({ action, ok: result.ok, detail: result.detail })
        }
        await options.manager.ensureRuntime()
        const result = await options.manager.ctl(action as CtlAction)
        return formatToolResult({
          action,
          ok: result.code === 0,
          output: `${result.stdout}${result.stderr}`.trim(),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await options.logger?.warn("chorus_daemon action failed", { action, error: message })
        return formatToolResult({ action, ok: false, error: message })
      }
    },
  })
}

async function runSetup(manager: DaemonToolManager, workdir: string | undefined): Promise<ToolResult> {
  const steps: SetupStep[] = []

  const runtime = await manager.ensureRuntime()
  steps.push({
    step: "install runtime",
    ok: true,
    detail: runtime.updated
      ? `installed daemon ${runtime.to}${runtime.from ? ` (was ${runtime.from})` : ""} at ${runtime.runtimeEntry}`
      : `daemon ${runtime.to} already installed at ${runtime.runtimeEntry}`,
  })

  const login = await manager.login(workdir)
  const loginOk = login.code === 0
  steps.push({
    step: "login + unattended defaults",
    ok: loginOk,
    detail: loginOk
      ? `credentials saved; serving directory: ${login.workdir}`
      : `login failed: ${`${login.stdout}${login.stderr}`.trim()}`,
  })
  if (!loginOk) return formatToolResult({ action: "setup", ok: false, steps })

  const autostart = await manager.autostart(true)
  steps.push({ step: "enable start-at-login", ok: autostart.ok, detail: autostart.detail })

  // setup just installed a fresh daemon binary + credentials, so any daemon left
  // over from a previous install must be REPLACED, not left running. Use restart
  // (stop-then-start against the just-persisted creds) instead of start, which
  // no-ops when a stale daemon is already up — that stranded the old code and old
  // identity, the classic "I re-ran setup but nothing changed" trap.
  const start = await manager.ctl("restart")
  const startOutput = `${start.stdout}${start.stderr}`.trim()
  const startOk = start.code === 0
  steps.push({ step: "start daemon", ok: startOk, detail: startOutput })

  const status = await manager.ctl("status")
  steps.push({ step: "status", ok: status.code === 0, detail: `${status.stdout}${status.stderr}`.trim() })

  const ok = steps.every((step) => step.ok)
  return formatToolResult({
    action: "setup",
    ok,
    steps,
    note: ok
      ? "Unattended mode is active: this machine now executes platform-dispatched tasks even with OpenCode closed. Local console: http://127.0.0.1:8638"
      : "Setup finished with failures — see the failing step above.",
  })
}

function formatToolResult(value: unknown): ToolResult {
  return JSON.stringify(value, null, 2)
}
