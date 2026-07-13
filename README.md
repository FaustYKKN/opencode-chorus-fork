<div align="center">

<img src="images/banner.webp" alt="opencode-chorus" width="100%" />

# opencode-chorus

> The [Chorus](https://github.com/Chorus-AIDLC/Chorus) integration plugin for [OpenCode](https://opencode.ai)

[![Version](https://img.shields.io/badge/Version-v0.10.0-blue?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/opencode-chorus)
[![License](https://img.shields.io/badge/License-AGPL--3.0-blue?style=for-the-badge&logo=open-source-initiative&logoColor=white)](./LICENSE)
[![With & For OpenCode](https://img.shields.io/badge/With_%26_For-OpenCode-000000?style=for-the-badge&labelColor=555555&logo=data:image/svg%2bxml;base64,PHN2ZyB3aWR0aD0nMjQwJyBoZWlnaHQ9JzMwMCcgdmlld0JveD0nMCAwIDI0MCAzMDAnIGZpbGw9J25vbmUnIHhtbG5zPSdodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Zyc+PGcgY2xpcC1wYXRoPSd1cmwoI2NsaXAwXzE0MDFfODYyODMpJz48bWFzayBpZD0nbWFzazBfMTQwMV84NjI4Mycgc3R5bGU9J21hc2stdHlwZTpsdW1pbmFuY2UnIG1hc2tVbml0cz0ndXNlclNwYWNlT25Vc2UnIHg9JzAnIHk9JzAnIHdpZHRoPScyNDAnIGhlaWdodD0nMzAwJz48cGF0aCBkPSdNMjQwIDBIMFYzMDBIMjQwVjBaJyBmaWxsPSd3aGl0ZScvPjwvbWFzaz48ZyBtYXNrPSd1cmwoI21hc2swXzE0MDFfODYyODMpJz48cGF0aCBkPSdNMTgwIDI0MEg2MFYxMjBIMTgwVjI0MFonIGZpbGw9JyM0QjQ2NDYnLz48cGF0aCBkPSdNMTgwIDYwSDYwVjI0MEgxODBWNjBaTTI0MCAzMDBIMFYwSDI0MFYzMDBaJyBmaWxsPScjRjFFQ0VDJy8+PC9nPjwvZz48ZGVmcz48Y2xpcFBhdGggaWQ9J2NsaXAwXzE0MDFfODYyODMnPjxyZWN0IHdpZHRoPScyNDAnIGhlaWdodD0nMzAwJyBmaWxsPSd3aGl0ZScvPjwvY2xpcFBhdGg+PC9kZWZzPjwvc3ZnPg==&logoColor=white)](https://opencode.ai)

</div>

---

## What Is This?

[**Chorus**](https://github.com/Chorus-AIDLC/Chorus) is an agent harness for AI-Human collaboration, inspired by the [AI-Driven Development Lifecycle (AI-DLC)](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/) methodology. It manages session lifecycle, task state, sub-agent orchestration, observability, and failure recovery — letting multiple AI agents and humans collaborate through the full workflow from requirements to delivery.

**opencode-chorus** is the community-maintained plugin that connects [OpenCode](https://opencode.ai) to your Chorus instance. It loads Chorus workflow skills, exposes an on-demand MCP tool bridge, and provides lifecycle hooks and reviewer automation — all without manual tool or skill configuration.

## Features

| Category | Components | Description |
|---|---|---|
| **Lifecycle Hooks** | State Management, Lazy MCP Bridge, Context Injection, Notification Coordination | Manages state, activates Chorus on first tool use, injects project context after activation, and routes notifications. |
| **Review Agents** | Proposal Reviewer, Task Reviewer | Automated reviewers that evaluate proposals and verify completed tasks with structured verdicts. |
| **Workflow Skills** | 8 bundled skills covering the full AI-DLC pipeline | `chorus`, `chorus-idea`, `chorus-proposal`, `chorus-develop`, `chorus-quick-dev`, `chorus-review`, `chorus-yolo`, `chorus-openspec` |

> [!NOTE]
> A local or online Chorus instance must be running and accessible to use this plugin. See [Chorus Quick Start](https://github.com/Chorus-AIDLC/Chorus#quick-start) to get one running.

For detailed component descriptions, see [docs/COMPONENTS.md](./docs/COMPONENTS.md).

## Quick Start

> [!TIP]
> This plugin is already included in the [Chorus upstream onboarding flow](https://github.com/Chorus-AIDLC/Chorus#connect-ai-agents). If you followed the Chorus setup guide for OpenCode, you can skip to step 2.

### 1. Install the Plugin

Add `opencode-chorus` to your OpenCode config file (usually `~/.config/opencode/config.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-chorus"]
}
```

### 2. Configure Credentials

Create a `chorus.json` in your OpenCode config directory (`~/.config/opencode/chorus.json`) with the minimal configuration:

```json
{
  "chorusUrl": "http://localhost:3000",
  "apiKey": "your-chorus-api-key"
}
```

Or use environment variables:

```bash
export CHORUS_BASE_URL="http://localhost:3000"
export CHORUS_API_KEY="your-chorus-api-key"
```

### 3. Restart OpenCode

After installing and configuring, restart OpenCode. You will see the bundled Chorus skills in your workspace. Load the `chorus` skill to get started.

The plugin does not connect to Chorus during OpenCode startup. It registers the lazy bridge tools immediately, then creates the Chorus session, starts notification listening, and enables system prompt context injection when you first call a Chorus bridge tool such as `chorus_tools` or `chorus_workspace_context`.

For all configuration options (environment variables, `chorus.json` fields, state storage, observability settings), see [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

## Unattended Daemon (fork addition)

This fork embeds the Chorus daemon (our chorus-fork build with the OpenCode wake
backend) inside the plugin package and manages it through one tool. In an
OpenCode session, ask the agent to run `chorus_daemon` with `action: "setup"` —
it installs the daemon runtime to `~/.chorus/runtime/`, logs it in with the
plugin's Chorus credentials, enables start-at-login, and starts it immediately.
From then on the platform wakes OpenCode on this machine even with every window
closed. Other actions: `start` / `stop` / `restart` / `status` / `logs` /
`autostart_on` / `autostart_off`. Requires Node 20+ on PATH.

The vendored bundle lives in `daemon/` and is regenerated from a chorus-fork
checkout with `bun run sync:daemon` (see `scripts/sync-daemon.mjs`). Re-run it
and commit the artifacts after every daemon-side change.

Zero-hand-editing install: the package ships an `init` command that merges the
plugin entry into the global OpenCode config (and removes a superseded native
`mcp.chorus` block). Once the package is on a registry:

```bash
npx opencode-chorus init            # or: npx @your-scope/opencode-chorus init
```

For a local tarball: `node <unpacked>/bin/cli.mjs init --spec "file:///path/to/opencode-chorus-x.y.z.tgz"`.

The `setup` command goes further: init **plus** the whole unattended
onboarding (install the embedded daemon runtime, login with unattended
defaults, register start-at-login, start now) in one deterministic command
under plain node — no OpenCode session, no model in the loop. With
`CHORUS_URL` / `CHORUS_API_KEY` exported, and a Chorus platform serving this
package's tarball at `<CHORUS_URL>/opencode-chorus-<version>.tgz`:

```bash
npx -y <CHORUS_URL>/opencode-chorus-<version>.tgz setup
```

It defaults the plugin spec to that same platform tarball URL (override with
`--spec`), and accepts `--url` / `--api-key` / `--workdir` when the env vars
are not set. Idempotent — re-run it any time to repair the installation.

## Documentation

| Document | Description |
|---|---|
| [Configuration](./docs/CONFIGURATION.md) | Full configuration reference — env vars, `chorus.json`, state storage, observability |
| [Components](./docs/COMPONENTS.md) | Detailed descriptions of lifecycle hooks, review agents, and workflow skills |
| [Changelog](./docs/CHANGELOG.md) | Release history and migration notes |

## License

[AGPL-3.0](./LICENSE)
