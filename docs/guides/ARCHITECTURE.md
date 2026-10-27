# Runtime architecture and refactoring approach

## Decision

Keep the current event-driven runtime and improve its internal boundaries incrementally. A wholesale rewrite is not justified by file size alone: the main runtime already implements the desired persistent-session and on-demand-observation model, while a replacement would put session recovery, wake behavior, and outbound safety controls at risk all at once.

Reconsider a larger redesign only when a concrete requirement cannot be implemented safely through a bounded change, or when repeated changes show that the current boundaries prevent reliable ownership and review of state.

## Runtime model

- Each allowed QQ conversation maps to a persistent DSH session using the fixed `qq-chat-v2` preset.
- Private messages wake their conversation. Group conversations wake only on a native @ directed to the bot or a verified reply/quote to the bot.
- Ordinary group messages are buffered by the bridge and are not automatically added to model context. During an active turn, the agent can choose to read recent or unread messages through the QQ tools. A direct wake may include its triggering message, not the rest of the buffer.
- The agent can choose to wait for messages or schedule a one-time wake. A persistent DSH session retains its session/context mapping; it does not mean a model is continuously running between turns.
- An authenticated operator can also explicitly start a turn from the WebUI for an allowlisted QQ-mapped session. This is a manual control action, not a QQ wake or periodic model heartbeat; the turn runs in DSH and its text is not forwarded to QQ automatically.
- QQ sends happen through guarded tools during an active DSH turn. Session tokens, allow/deny lists, rate limits, and audit checks are runtime invariants.
- SnowLuma supplies the inbound OneBot event stream needed to detect direct events and maintain the bridge's message buffer. Content reads are agent-directed. Infrastructure health polling and event heartbeats are separate from model wakeups; they do not run model turns.
- There is no periodic model heartbeat or timer-driven model polling.

These are the current runtime semantics. The user-facing permission contract remains in [../../RULES.md](../../RULES.md); update it if an intentional change alters these guarantees.

## Current code shape

`src/bridge.js` is the composition and orchestration center. It currently combines startup/configuration, OneBot event intake, DSH session lifecycle, wake and wait scheduling, conversation buffers, console HTTP routes, and outbound policy enforcement. Much of this behavior shares state held in the bridge runtime, which makes cross-cutting changes harder to isolate.

Several boundaries already exist: `src/autonomy-policy.js` contains pure wake classification, `src/dsh-client.js` wraps DSH communication, and the MCP, media, role-card, fetch, and token-ledger modules isolate other capabilities. Continue from these seams instead of replacing the runtime wholesale.

The following are candidate responsibilities for gradual extraction; they are design boundaries, not a required directory layout:

1. **Runtime composition** — startup, dependency wiring, and shutdown.
2. **QQ gateway** — normalize inbound OneBot events and perform outbound QQ transport.
3. **Session manager** — persistent conversation-to-DSH mappings, recovery, retirement, and preset binding.
4. **Autonomy scheduler** — wake classification, per-conversation queues, active-turn coordination, waits, and one-time sleep timers.
5. **Conversation store** — bounded message buffers, read watermarks, and on-demand history views.
6. **Console API** — administrative HTTP routes, separated from message and session policy.
7. **Outbound guard** — one authoritative send path for turn, token, target, rate, and audit checks.

## Refactoring rules

- Start with a concrete responsibility and identify who owns its state before moving code.
- Make one cohesive extraction per change. Preserve current inputs, outputs, persistence formats, and wake/read behavior unless a behavior change was requested separately.
- Pass narrow dependencies into extracted modules. Avoid new imports from the bridge entry point that recreate hidden global coupling.
- Do not distribute or duplicate outbound authorization checks. Every send must still pass the same authoritative guard immediately before it is issued.
- Keep transport intake distinct from model observation: receiving an event to classify a wake or buffer a message does not authorize adding ordinary message contents to a model prompt.
- Document state migrations and keep them explicit; a structural refactor should not silently reset sessions, watermarks, or buffered conversations.
- Keep unrelated feature removal or product behavior changes separate from mechanical extraction when practical, so each change has a clear reason and can be reviewed independently.
- Update [RULES.md](../../RULES.md) and the relevant user documentation when runtime semantics or security guarantees intentionally change.

## When to consider a larger redesign

A broader redesign may be warranted if a concrete goal requires persistent background work beyond event turns and explicit one-time wakes, if state ownership cannot be made clear with bounded extractions, or if existing interfaces repeatedly block safe changes. First describe the required runtime behavior and its trust boundaries; then choose the smallest architecture that supplies them. Do not introduce continuous model activity, extra tool permissions, or broader automatic message ingestion merely as part of a structural rewrite.
