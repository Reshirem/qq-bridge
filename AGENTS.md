# qq-bridge agent guidance

Before changing runtime architecture, read [docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md) and [RULES.md](RULES.md). Read [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md) before changing security-sensitive code. Module and script locations are indexed in [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md).

## Default change approach

- Prefer a small, behavior-preserving, incremental refactor. The large size of `src/bridge.js` alone is not a reason to replace the runtime.
- Change one cohesive responsibility at a time. Keep policy changes separate from mechanical code movement where practical.
- Preserve persistent session/state semantics and existing API contracts unless the user explicitly asks to change them. Make any state migration explicit.
- Keep module dependencies narrow and explicit. Extracted modules should receive the capabilities they need rather than reaching into bridge-wide mutable state.
- Preserve the existing outbound checks: global `desktop-agent` sends must validate the internal agent token, canonical target key (`^(group|private):\d+$`), sensitive-content/token-leak filters, and audit logging; `allow/deny` lists gate console test-sends (`allowed()`). Do not gate MCP tool calls on `agent_rest` lifecycle state (`idle`, `active`, `resting`, `recovering`, `sleeping`, `stopped`): `agent_rest` (or `qq_agent_rest`) ends the current model turn, while sleep and WebUI stop control automatic scheduling and wake behavior.
- Keep all QQ message bodies out of the main agent's wake/steer prompts until it requests them via QQ tools. All six QQ attention signal types (private message, native `@`, verified reply/quote, active role card name, configured keywords, and incoming QQ poke events) and incoming QQ friend-request / group-invitation notifications (`friendRequest` and `groupInvite`, gated by `enabled` and `reminders.private`) deliver metadata only (conversation/group key, sender ID, `id:`/`seq:` locator, and count; never friend-request comments, group names, or nicknames).
- Keep background DSH tasks isolated and tool-restricted:
  - The background chat learner (`chat-learning` / `market-analysis` DSH Host presets, with isolated headless fallback) may analyze bounded, source-specific batches using only its bound batch-image tool; it cannot send QQ messages or control the main agent.
  - The independent `memory-curator` may only evaluate same-source stored paragraphs supplied in its batch and cannot execute tools. The bridge validates and journals reversible Gateway writes.
  - The daily memory organizer (`memory-organizer` DSH Host preset, with isolated headless fallback) may only read visible evidence already recorded in the main DSH session (`session/page` + `readThroughSeq`), never unread QQ buffers, and is restricted to the five memory tools (`memory_search/save/read/replace/forget`).
- Run the bridge on the Windows desktop QQ channel (`NativeQQ` + `openNativeReminders`) behind the `mcp__qq__*` tool surface. Keep legacy plugin IDs (`mcp-snowluma`, `mcp-snowluma-host`) disabled in DSH cleanup lists and preserve process-control/license guards (`src/mcp-qq.js` must not use `child_process` or process-control primitives).
- Do not add a periodic model heartbeat, broaden the agent's route allowlist, reintroduce per-QQ-conversation DSH sessions, or reintroduce automatic filesystem ACL mutation / UAC elevation.
- When editing `dsh/agent-presets/desktop-agent/prompt-modules.json`, keep `agent.cordis.yml` in sync and run `node scripts/build-agent-preset-patches.mjs` to update `plugins/qq-agent-presets/presets/desktop-agent.patch.yml`.
- Verify changes offline with `node --check src/bridge.js`, `node scripts/build-agent-preset-patches.mjs --check`, `npm test` (`node scripts/test-audit.mjs`), and `node scripts/privacy-scan.mjs --tracked-only`. Do not run live or side-effecting scripts (`npm run verify:dsh`, `npm run self-test`, `scripts/ntqq-probe/send_test.py`) unless the user explicitly asks.
- Keep documentation synchronized in the same change (see the mapping table in [README.md](README.md#开发与文档同步规范接手必读)):
  - Edit the relevant section in place rather than prepending or appending patch paragraphs at the top/bottom of a file; remove superseded statements so a document never contains conflicting rules.
  - Do not commit daily debugging journals as reference guides.
  - Update [config.example.json](config.example.json) and [README.md](README.md) when config keys, defaults, or runtime prompt templates change; update [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md) when adding/removing modules or scripts; update [docs/README.md](docs/README.md) when adding/removing docs; update [RULES.md](RULES.md), [docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md), and [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md) when behavior or security boundaries change.

The current runtime and suggested module boundaries are described in [docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md). Treat those boundaries as a gradual direction, not a requirement to move every function at once.
