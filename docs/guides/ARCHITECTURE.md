# Runtime architecture and refactoring approach

## Decision

The runtime now uses one persistent global `desktop-agent` session for WebUI work and new QQ attention signals. Continue cleaning up the remaining per-conversation compatibility paths incrementally; do not start a broad rewrite just to reach the already-implemented session model.

Keep each cleanup reviewable, preserve explicit state migrations, and avoid sending new QQ events to both the global and legacy runtimes.

## Current implementation

- New autonomous work uses one persistent `desktop-agent` DSH session. Existing per-QQ session mappings remain temporarily for compatibility and manual administration; new QQ events no longer start those per-conversation agents.
- SnowLuma supplies the inbound OneBot event stream. The bridge buffers readable messages across groups and private conversations. Ordinary group messages remain out of model context.
- Private messages, native @ mentions to the bot, verified replies/quotes to the bot, and configured `socialV2.attentionKeywords` are batched into metadata-only signals for the global session. The signal has source IDs and trigger information, not message text. The agent may ignore it.
- The global desktop agent has the complete tool set currently registered by `mcp-snowluma-safe.js`, including `qq_list_conversations`, message reads and writes. Its global session token can target any syntactically valid QQ group/private key; per-conversation `allow.*` and `deny.*` lists are not required for this session. Direct QQ database access remains deferred.
- SnowLuma sends still require a valid global or legacy session token and an active DSH turn. Bridge API sends retain rate limiting and message/tool audit. Computer-use actions in the QQ UI do not pass through those bridge API checks.
- The agent may choose to wait for messages or configure one global one-shot wake. There is no periodic model heartbeat or timer-driven model polling.
- A persistent DSH session is not continuously active. It runs only on a QQ attention signal, explicit WebUI task, or one-shot/wait mechanism selected during a turn.

These are the current runtime semantics. The user-facing permission contract for the current implementation remains in [../../RULES.md](../../RULES.md).

## Product direction now reflected in the runtime

- There is one long-lived DSH agent for the user, rather than a separate DSH session for every QQ group or private chat. The WebUI is the primary place to start, inspect, and guide this agent.
- QQ is one capability the agent may use, alongside its ability to operate the local computer through `dsh-computer-use-win`. It may choose when to inspect QQ messages and which group or private conversation to read.
- QQ conversation IDs remain useful as source and target identifiers for indexing, reading, and sending. They do not define separate DSH sessions or separate agent identities.
- New QQ @ mentions and configured keywords are attention signals: they can wake or notify the agent that something may need attention, but do not require it to read the message, respond, or take an action. Message bodies should remain out of model context until the agent chooses to read them.
- A persistent DSH session does not mean the model is continuously active. With no periodic model heartbeat, it can make a choice only during a turn started by an external signal, an explicit WebUI action, or a wait/wake mechanism it selected during an active turn.
- Broad computer use is an intended capability for this local agent. Before QQ-originated content can influence computer actions, define how message source and trust affect wakeups and actions; a message being visible to the agent does not by itself authorize every requested operation.

### Migration status

The WebUI provides an explicit task entry for the lazily created `desktop-agent`. A qualifying QQ event can also create/reuse that same session and start a turn, but the event contributes metadata only. The preset exposes `mcp__wincu__*`, the full current `mcp__snowluma__*` QQ tool namespace, the read-only `mcp__snowluma-host__snowluma_status` tool, and harmless ask-user/todo tools. The global agent may enumerate the account's groups and friends, then reads messages only when it chooses a SnowLuma read tool or inspects the QQ desktop app.

The global event-routing slice is implemented. The per-conversation session lifecycle, old wake scheduler, and QQ mapping console remain as compatibility code; continue retiring or extracting them in small changes after checking their state migrations and callers. Direct QQ database reading remains deferred below.

### Deferred experiment: direct QQ database reading

Reading messages from the local NTQQ database instead of receiving them from SnowLuma remains a technical experiment, not part of the current implementation plan. Key extraction, live encrypted-database/WAL access, message protobuf parsing, and reliable @/reply classification have not been validated. Do not start this experiment or add a database-reader branch until the user brings it up again.

## Current code shape

`src/bridge.js` is the composition and orchestration center. It currently combines startup/configuration, OneBot event intake, per-QQ-conversation DSH session lifecycle, wake and wait scheduling, conversation buffers, console HTTP routes, and outbound policy enforcement. Much of this behavior shares state held in the bridge runtime, which makes cross-cutting changes harder to isolate.

Several boundaries already exist: `src/autonomy-policy.js` contains pure wake classification, `src/dsh-client.js` wraps DSH communication, and the MCP, media, role-card, fetch, and token-ledger modules isolate other capabilities. Continue from these seams instead of replacing the runtime wholesale.

The following are candidate responsibilities for gradual extraction; they are design boundaries, not a required directory layout. The target direction may change the session and transport responsibilities, so keep their contracts small enough to replace:

1. **Runtime composition** — startup, dependency wiring, and shutdown.
2. **QQ gateway** — normalize inbound OneBot events and perform outbound QQ transport.
3. **Agent/session manager** — one global persistent DSH session and its recovery; keep QQ conversation IDs in the message store, not as DSH session identities.
4. **Autonomy scheduler** — advisory wake signals, active-turn coordination, waits, and one-time wakes; do not require a per-conversation DSH queue.
5. **QQ data store/source** — message indexing, source metadata, deduplication, and on-demand conversation reads, independent of the eventual QQ transport or database adapter.
6. **Console API** — administrative HTTP routes, separated from message and session policy.
7. **Action policy** — explicit authorization and audit for QQ sends and local computer operations, while allowing the intended desktop-control capability.

## Refactoring rules

- Start with a concrete responsibility and identify who owns its state before moving code.
- Make one cohesive extraction per change. Preserve current inputs, outputs, persistence formats, and wake/read behavior unless a behavior change was requested separately.
- Pass narrow dependencies into extracted modules. Avoid new imports from the bridge entry point that recreate hidden global coupling.
- Do not distribute or duplicate action authorization checks. Any replacement for the current QQ send guard must explicitly cover both the intended computer-use path and any direct QQ transport retained during migration.
- Keep activity detection distinct from model observation: a QQ event or keyword/@ signal does not automatically add message contents to the global agent context or require a response.
- Document state migrations and keep them explicit; a structural refactor should not silently reset sessions, watermarks, or buffered conversations.
- Keep unrelated feature removal or product behavior changes separate from mechanical extraction when practical, so each change has a clear reason and can be reviewed independently.
- Update [RULES.md](../../RULES.md) and the relevant user documentation when runtime semantics or security guarantees intentionally change.

## When to consider a larger redesign

The global session model is already in place, so a broad architectural rewrite is not currently necessary. Reconsider one only if the remaining compatibility subsystems prevent a concrete feature or make a state migration unreasonably risky. Keep model work event-driven; do not inject every QQ message just to make the agent appear autonomous.
