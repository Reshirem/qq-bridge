# Fixed prefix snapshot

Captured on 2026-10-28 before installing the unified companion-oriented rewrite. This snapshot preserves the rendered persona prefix, its module content and enabled states, and the editor definitions used to compose it.

- `prefix.txt`: exact model-facing `persona.prefix` text.
- `agent.cordis.yml`: complete DSH preset source at capture time.
- `prompt-modules.json`: editable module bodies and enabled states.
- `preset-prompt.js`: module order, labels, validation and YAML composition logic at capture time.

To restore the exact DSH preset source, copy `agent.cordis.yml` back to `dsh/agent-presets/desktop-agent/agent.cordis.yml` and regenerate the bundle patch with `node scripts/build-agent-preset-patches.mjs`. To restore the WebUI editor state as well, restore `prompt-modules.json` and `src/preset-prompt.js` from this snapshot.
