# QQ ↔ DeepSeek Harness Bridge (qq-bridge)

> The project uses one persistent global DSH desktop agent. The WebUI is its main control surface, and QQ is a message channel the agent can choose to use. SnowLuma events enter the bridge buffer; private messages, native @ mentions, verified replies/quotes, and configured keywords send metadata-only attention signals to the global session. The agent may choose whether to read or write QQ through the complete current SnowLuma MCP tool set, or use `dsh-computer-use-win` to operate the desktop. Per-conversation DSH session mappings and their control surface have been removed from the current code and preset bundle.

> ⚠️ **Current release `v0.2.1-r1`, targets DSH 0.2.1-rc.2** (also compatible with 0.2.0-rc.2; verified item by item on both — run `npm run verify:adaptation`). It uses the persistent local signing key to **mint the session Cookie offline**, slash RPC endpoints and the `/api/remote.mux` event stream — a protocol generation introduced in DSH `0.1.2-alpha.1`, incompatible with the older dot-endpoint protocol. Reading the launch token out of the old guard logs has not worked since DSH 0.1.7 (the token is generated per process and never written to disk). Agent presets are `@deepseek-ai/dsh-agent-preset` Cordis rows since DSH 0.1.7 (the `~/.dsh/.agent-presets/` directory mechanism is gone). On **DSH `0.1.1-rc.2` or earlier**, use tag [`v0.1.0`](https://github.com/Reshirem/qq-bridge/releases/tag/v0.1.0); for **DSH 0.1.5-rc.1** use [`v0.1.5`](https://github.com/Reshirem/qq-bridge/releases/tag/v0.1.5); for **DSH 0.1.7-rc.2** use [`v0.1.7`](https://github.com/Reshirem/qq-bridge/releases/tag/v0.1.7).
>
> **r4 highlights**: sticker/animated-emoji pipeline (CDN first, `emoji_id` fallback, multi-address DNS failover), web search now reuses DSH's own DeepSeek search backend (Bing only as fallback), `qq_wait_for_messages` long-polling past the 300 s undici timeout, plus fixes for the mode-switch rollback, permanent "busy" turns, missing self-identity injection and a full-project audit. Details: [Release v0.2.0-r4](https://github.com/Reshirem/qq-bridge/releases/tag/v0.2.0-r4).
>
> **v0.2.1-r1 highlights**: DSH 0.2.1-rc.2 adaptation. Fixes a **P0** — the `{{cwd}}` prompt variable used by the QQ preset files at that time was removed in DSH 0.2.1, so every affected turn failed during system-prompt assembly before the model ran (QQ showed it as "no reply at all"). Also adds the newly global `working_directory` tool plus the terminal / session-query / plugin-market families to the safety guard. Details: [docs/guides/DSH_021_ADAPTATION.md](docs/guides/DSH_021_ADAPTATION.md), a historical adaptation snapshot.
>
> The default branch `main` **is** this version — a plain `git clone` gets it, no branch switching needed.

For the current runtime model and incremental-refactoring policy, see **[docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md)**.
Setup instructions are in **[docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md)**. The documentation index is **[docs/README.md](docs/README.md)**;
the repository map is in **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**, and coding-agent instructions are in **[AGENTS.md](AGENTS.md)**.

## Architecture

```
WebUI task ──────────────────────────► global DSH desktop-agent ──► Windows desktop / SnowLuma MCP
QQ messages ──► SnowLuma (OneBot v11 WS) ──► bridge buffer ──metadata signal──► same global session
```

- **QQ side**: `@snowluma/sdk` provides the OneBot v11 WebSocket client.
- **DSH side**: adapted for DSH 0.1.2+ and **re-verified on 0.2.1-rc.2** — session Cookie minted from the persistent local signing key, `/api/<namespace>/<method>` slash RPC, and `/api/remote.mux` + `session/follow` event stream (the pending queue is read from `value.projections[<id>].values.inbox`, with the unary `session/projections` RPC as the primary path). The bridge applies `dsh.provider`, `dsh.model`, and `dsh.reasoningEffort` through `session.selectModel` (default `deepseek-flash` = DeepSeek-V41-Flash, multimodal).
- **Agent tools**: the global desktop agent gets the complete current SnowLuma message/media MCP tool set and can target any valid QQ group or private-conversation key. Sends require an active DSH turn and remain rate-limited and audited. This does not include OneBot group-administration APIs that the project has not registered as MCP tools.
  ⚠️ **`start_snowluma` / `stop_snowluma` (and `snowluma.allowProcessControl`) were removed in v0.1.5**: SnowLuma EULA §5.4 requires prior written permission to deploy its proprietary native components through automated scripts. This program only probes, never deploys — installing, starting and scanning SnowLuma is always up to you. See [LICENSE](LICENSE) and [RULES.md](RULES.md).
- **Console**: a local web console at `http://127.0.0.1:3100`, organised into task-based pages for overview, session control, assistant prompts, QQ messaging, usage, access and operations. The Session Control page starts or resumes autonomous exploration, accepts explicit tasks, and persistently stops the global agent; the prompt editor maintains `desktop-agent` and regenerates its bundle patch. The console also manages attention keywords, administrator settings, logs, and DSH model/reasoning settings. It loads available models and reasoning options from DSH when possible, with manual provider/model IDs as a fallback.
  - **WebUI session control**: the Session Control page starts or resumes autonomous exploration, submits tasks, or stops and cancels current/queued DSH work. Every active turn should finish by calling `agent_rest` as its final tool call. A finite rest of 1 second to 12 hours triggers one turn at expiry; a valid QQ attention signal can also end rest early and wake one turn. Exponential recovery retries are suspended while resting. If a turn ends without the tool, the bridge retries with exponential delays capped at 30 minutes. A WebUI stop suppresses all automatic retries until a user manually starts or submits a task. After updating the preset, restart DSH, then recreate the global session from the console; the old session is archived with its history retained.

## Features

- One persistent global DSH desktop agent for WebUI tasks and QQ signals; QQ conversations do not get separate agent contexts.
- `dsh-computer-use-win` and the complete current SnowLuma MCP message/media tool set. The agent may read or write any valid QQ group or private-conversation key.
- Private messages, native @ mentions, verified replies/quotes and configured keywords are optional metadata-only attention signals. Ordinary group messages stay in the bridge buffer for on-demand reads; no message body is automatically inserted into the agent prompt. No periodic model heartbeat or long wait used only for keeping the session online runs.
- Each active turn ends with `agent_rest`; finite rest (up to 12 hours) triggers one future turn, and valid QQ attention can interrupt finite or indefinite rest. A missing rest call triggers exponential recovery, while the persistent WebUI stop state disables automatic recovery.
- SnowLuma MCP sends require a session token and active turn, and remain rate-limited and audited. A send through the desktop UI is a computer-use action outside those bridge API checks.
- Sensitive text audit prevents paths/credentials from being sent to QQ.
- MCP tools for on-demand message/history reads, member lookups, quote replies and stickers; attention signals contain metadata, not message text.
- Sticker library integration with AI-friendly sticker usage.
- Voice send, receive and transcription are not supported by the current bridge runtime.

## Requirements

- Node.js >= 22.13
- Running DSH Desktop or Web API. Windows Desktop may assign a dynamic API port; `dsh.autoDetectPort` discovers it when the bridge starts. Fixed deployments use `dsh.baseUrl` (default `http://127.0.0.1:3080`).
- Running SnowLuma with OneBot v11 WebSocket and HTTP API enabled

## Quick Start

```bash
npm install        # postinstall automatically patches the @snowluma/sdk ESM packaging bug
```

Copy `config.example.json` to `config.json`, then edit:

```bash
cp config.example.json config.json
```

Key settings:

| Field | Description |
| --- | --- |
| `dsh.baseUrl` | Fixed DSH API URL and discovery fallback, default `http://127.0.0.1:3080` |
| `dsh.autoDetectPort` | Default `true`. On Windows, detects the API listener owned by the DSH Desktop process when the bridge starts. Start DSH first; the discovered URL is used for this run and is not written to config. If none is found, `baseUrl` is used; if multiple APIs match and `baseUrl` is not one of them, startup refuses to guess. Configure `baseUrl` to select the intended endpoint |
| `dsh.authToken` | DSH launch token (a process-launch credential). **Normally leave this empty**: with no token the bridge mints the session cookie offline from the persistent signing key in `~/.dsh/.credentials.yaml`, which depends on no per-process state (since DSH 0.1.7 the launch token lives only in memory — the one in the old logs belongs to a previous process and only yields a 401). A value here is honoured first if you set one |
| `dsh.authHeader` / `dsh.authPrefix` | Legacy fields kept for compatibility; the current path uses Cookie auth and does not send this header |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** URL (e.g. `ws://127.0.0.1:3001`) |
| `snowluma.accessToken` | OneBot access token, leave empty if not configured |
| `snowluma.httpUrl` | OneBot **HTTP API** URL (e.g. `http://127.0.0.1:3000`); do not point this at the WebSocket port or you will get HTTP 426 |
| `ownerQQ` | Optional administrator QQ for compatible QQ admin commands; it can also come from the DSH `qq-mode.ownerQQ` setting |
| `socialV2.attentionKeywords` | Optional keyword list for group-chat attention signals; matching sends metadata only, not message text |
| `socialV2.media` | Incoming image/sticker limits: `maxBytes` (8 MB per message by default), `maxPixels` (64 MP per image), and `maxCount` (5 per message). Images sent to the model are normally kept under 1 MiB; resizing large images and extracting animated-sticker frames require FFmpeg. See the [DSH setup guide](docs/guides/DSH_SETUP.md#图片与动图依赖) |
| `allow.private` / `allow.groups` | Whitelist used by console direct test-send actions; the global agent's SnowLuma tools can target any valid QQ key |
| `consolePort` / `consoleToken` | Fixed local console port (default `3100`) and access token. The bridge exits if the port is occupied; a blank token is generated and saved to `state/console-token`. After login, the browser session uses an HttpOnly cookie |
| `memory.enabled` / `baseUrl` / `namespace` / `apiKey` | Optional A_Memorix long-term memory. Disabled by default; deploy its local HTTP/JSON Gateway and create a fixed namespace API key first. The key stays in untracked `config.json`. |
| `memory.timeoutMs` / `bootstrapLimit` / `bootstrapMaxChars` | Gateway request timeout and the new-session summary count/character limits; defaults are `45000` ms, `6`, and `2500`. See [the memory guide](docs/guides/MEMORY_ARCHITECTURE.md) |

Start:

```bash
npm start
```

Or double-click `start.bat` on Windows (guard mode with auto-restart).
Start DSH before the bridge on Windows so Desktop API port discovery can find its current listener.

## DSH Setup on Another Device

The bridge and console can run without extra DSH setup, but the `desktop-agent` preset and MCP tools must be installed into DSH once per machine. The global agent also requires `dsh-computer-use-win` to be enabled in that DSH profile:

```bash
node scripts/setup-dsh.mjs
```

This installs:

- the `qq-agent-presets` bundle, which generates the single `desktop-agent` row and shared `qq-tool-restrict` guard
- MCP entries in `~/.dsh/profiles/web/cordis.patch.yml`, including the optional A_Memorix memory facade
- `qq-mode-console` and `qq-agent-presets` in the profile `package.json` (`bundles` + `link:` dependencies)
- All autonomous activity uses the persistent global `desktop-agent`. Setup does not configure DSH runtime modes or create `state/mode.json`. The historical `qq-mode` namespace remains for the DSH `ownerQQ` administrator setting; its legacy `mode` field does not affect runtime behavior.

Then restart DSH. See [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) for details.

When A_Memorix is configured, the WebUI provides memory search and maintenance. The agent receives a compact assistant-origin memory summary once when a new or rebuilt global session starts; QQ-origin memory remains on demand. See [the memory guide](docs/guides/MEMORY_ARCHITECTURE.md) for deployment and API limitations.

## Security Notes

- `config.json` and `state/` are **never committed**; the repository only ships `config.example.json`. Both are ACL-hardened to the owner / SYSTEM / Administrators (`npm run harden-acl`).
- Global SnowLuma MCP tools can read and write any valid QQ group/private key. Sends require the global session token and an active DSH turn; the bridge still applies rate limits and audit.
- Local paths, credentials, tokens and other sensitive patterns are filtered by the audit layer.
- The global `desktop-agent` gets `mcp__wincu__*`, the complete current `mcp__snowluma__*` QQ namespace, the read-only `mcp__snowluma-host__snowluma_status` tool, and `mcp__qq-memory__*` (when configured). It may list the account's groups and friends, then read or write any valid conversation key. Shell, generic filesystem, subagent and Harness-management tools remain hidden and guarded.
- QQ actions made through the desktop UI do not pass through the bridge's API send token, rate limit or audit checks.
- The console uses a generated token when none is configured.

## Repository Layout

```
qq-bridge/
  AGENTS.md             # coding-agent instructions for this repository
  config.example.json   # sanitized config template (real config.json is not in repo)
  docs/
    README.md           # index of documents present in this repository
    FOLDER_MAP.md       # folder layout and scripts/ naming conventions
    guides/             # architecture, setup, security, privacy, console and compatibility guides
  dsh/agent-presets/    # the desktop-agent preset source
  plugins/qq-agent-presets  # DSH bundle: desktop-agent row + shared tool guard
  plugins/qq-mode-console  # DSH compatibility settings namespace for ownerQQ; no runtime mode selector
  src/                  # bridge core and MCP servers
  public/
    console.html        # local web console
  roles/                # persona cards
  assets/               # images (the intro video ships as a release asset, not in the repo)
  scripts/              # tests and helper scripts
  state/                # runtime data, created locally and not committed
```

## Testing

`node scripts/test-audit.mjs` runs isolated regression checks without production credentials, DSH, or QQ messages. See [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md) for the current security contract and [docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md) for the runtime model.

After upgrading, QQ attention signals use the global `desktop-agent`. The bridge no longer creates or administers per-conversation DSH session mappings; historical session records remain under DSH's own management.

```bash
npm run self-test       # DSH-side link test, no QQ/SnowLuma required
npm run test-md
npm run test-wait
npm run test-vision
npm run test-forward
npm run test-stickers
```

## Compliance

SnowLuma is an independent third-party project and is not affiliated with Tencent/QQ. This project is for learning and technical research only; please follow the relevant terms and the QQ User Agreement.
