# qq-bridge agent guidance

Before changing runtime architecture, read [docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md) and [RULES.md](RULES.md). Read [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md) before changing security-sensitive code.

## Default change approach

- Prefer a small, behavior-preserving, incremental refactor. The large size of `src/bridge.js` alone is not a reason to replace the runtime.
- Change one cohesive responsibility at a time. Keep policy changes separate from mechanical code movement where practical.
- Preserve persistent session/state semantics and existing API contracts unless the user explicitly asks to change them. Make any state migration explicit.
- Keep module dependencies narrow and explicit. Extracted modules should receive the capabilities they need rather than reaching into bridge-wide mutable state.
- Preserve the existing outbound checks for session tokens, allow/deny lists, rate limits, and audit controls. Do not gate MCP tool calls on `agent_rest` lifecycle state: `agent_rest` ends the current model turn, while WebUI stop controls automatic scheduling and recovery.
- Keep ordinary group message bodies out of model context until the agent requests them. A direct private-message or verified group mention/reply wake may include only its triggering message.
- Do not add a periodic model heartbeat or broaden the QQ agent's route allowlist as a side effect of structural work.
- Update the architecture and security documentation when an intentional behavior or security boundary changes.

The current runtime and suggested module boundaries are described in [docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md). Treat those boundaries as a gradual direction, not a requirement to move every function at once.
