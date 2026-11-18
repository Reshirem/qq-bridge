# 长期记忆整理、去重与合并升级方案（Memory Consolidation Plan）

本文档面向开发者与编码 AI Agent，定义 `qq-bridge` 长期记忆（基于 `A_Memorix`）的**检索去重、同专题合并替换（`memory_replace`）与后台碎片整合**实施方案。

开始修改代码前，请先阅读：
- [AGENTS.md](../../AGENTS.md)
- [长期记忆方案](MEMORY_ARCHITECTURE.md)
- [安全基线](SECURITY_BASELINE.md)

---

## 一、背景与现存痛点

随着全局数字角色在长期会话中持续通过电脑/浏览器自主钻研（`origin="assistant"`）以及参与 QQ 群聊/私聊（`origin="qq"`），长期记忆库会出现明显的**碎片化与 Top-K 挤占问题**：

1. **检索窗口极小（Top-K 挤占效应）**：
   - 会话启动时的记忆摘要引导（`memoryBootstrap`，见 `src/bridge.js` 约 7276 行）默认仅取 `bootstrapLimit = 6` 条；
   - 日常 `memory_search`（见 `src/a-memorix-gateway.js` 约 123 行）默认仅返回 `limit = 8` 条。
   - 当同一个研究课题、同一个人物或同一件事分多次写入了 4～5 条零散甚至过时的记录时，`memory_search` 的前 8 个坑位会被同一话题的碎片占满，导致其他真正重要的记忆被挤出 Top-K 之外。
2. **`supersedes`（以新替旧）在检索层未过滤**：
   - `memory_save` 虽然支持写入 `metadata.supersedes` 记录被更正的旧 `memoryId`，但 `src/a-memorix-gateway.js` 的 `search()` 并未过滤已被新记录 `supersedes` 的旧记录，导致**过时/错误的旧记忆与更正后的新记忆同时出现在检索结果中**。
3. **缺少面向 Agent 的原子「合并/替换」工具**：
   - `src/a-memorix-gateway.js` 已实现“先写新记录、确认落盘后再删旧记录”的 `replace()` 方法（约 234 行），但目前仅暴露给 WebUI 管理端（`/api/memory/replace`），未暴露给 `src/mcp-memory-safe.js`（MCP 工具）与 `/api/desktop-agent/memory/:op`，且仅支持替换单条 `memoryId`，不支持将多条同主题碎片合并为一条。
4. **独立记忆整理器（`memory-organizer`）只增不减**：
   - `src/bridge.js` 中的 `MEMORY_ORGANIZER_SYSTEM_PROMPT`（约 2100 行）目前仅将 DSH 会话事件流摘抄为新记忆写入，并要求“保留旧记录，不要删除”，长期运行后旧碎片越积越多。

---

## 二、必须遵守的架构与安全红线

实现本方案时，必须严格保持以下边界不变：

1. **Gateway 唯一写入所有权**：
   - 所有记忆写入、替换与删除必须走 `src/a-memorix-gateway.js` 的 HTTP/JSON Gateway 接口，严禁直接读写或修改 `state/a-memorix/data/` 下的 SQLite / 向量文件。
2. **来源分类与跨群隔离**：
   - `origin` 枚举严格限制为 `'qq' | 'assistant'`。
   - **严禁跨 QQ 来源合并**：不同 QQ 群（`group:群号`）或私聊（`private:QQ号`）的记忆不得合并为同一条记录；合并同一来源的多条记忆时，必须保留明确的 `sourceContext`、说话人归属与去重后的 `evidenceReferences`。
3. **先写后删（Fail-safe 事务顺序）**：
   - 任何合并或替换操作必须**先核实旧记录存在 → 再将合并后的新记录写入 Gateway 并拿到有效 `storedIds[0]` → 最后删除被替代的旧记录**。若新记录写入失败，不得删除任何旧记录。
4. **防幻觉 ID 校验**：
   - 模型调用替换/合并工具前，传入的旧 `memoryId` 必须真实存在（在 `replace()` 内部先 `read()` 校验）；若任一旧 `memoryId` 不存在或为占位词（如 `PLACEHOLDER`），直接报错拒绝，不执行写入或删除。

---

## 三、分阶段实施方案

建议按以下 3 个阶段递进实现，每个阶段均可独立验证。

### Phase 1：检索层自动折叠被 `supersedes` 的旧记录与重复内容

**涉及文件**：`src/a-memorix-gateway.js`

1. **规范化 `supersedes` 元数据格式**：
   - 支持 `metadata.supersedes` 为单个字符串（如 `"mem_old_1"`）或字符串数组 / 逗号分隔字符串（如 `["mem_old_1", "mem_old_2"]`）。
   - 编写辅助函数 `extractSupersededIds(metadata)`，返回去重后的非空字符串数组。
2. **在 `search()`（`src/a-memorix-gateway.js` 约 123～160 行）中过滤已淘汰记录**：
   - 向 Gateway 发起 `search` 请求时，适当放大底层拉取条数（例如 `const fetchLimit = Math.min(50, Math.max(requestedLimit * 2, requestedLimit + 10))`），以便在过滤被替代记录和按 `origin` 过滤后仍有充足候选。
   - 遍历 Gateway 返回的 `hits`，收集所有命中项 `hit.metadata` 中声明的 `supersedes` ID 集合 `supersededIds`。
   - 过滤掉满足以下任一条件的命中项：
     - `supersededIds.has(hit.memoryId)`（已被更新的记录明确替代）；
     - 与前面更高分/更新的命中项正文完全一致（对 `hit.content.trim().replace(/\s+/g, ' ')` 去重）。
   - 最后按 `requestedLimit` 截断返回。
3. **新会话启动引导（`src/bridge.js` 约 7276～7315 行 `buildDesktopAgentMemoryBootstrap`）同步受益**：
   - 由于 `buildDesktopAgentMemoryBootstrap` 直接调用 `memoryGateway.search()`，完成上述过滤后，开局的 6 个黄金坑位将自动剔除已被替代的过时记录与重复记录。

---

### Phase 2：向 MCP 与主角色开放 `memory_replace`（支持单条更新与多条碎片合并）

**涉及文件**：
- `src/a-memorix-gateway.js`
- `src/bridge.js`
- `src/mcp-memory-safe.js`
- `src/memory-organizer-tool-guard.mjs`
- `dsh/agent-presets/desktop-agent/prompt-modules.json`（及同步生成的预设文件）

#### 1. 升级 `src/a-memorix-gateway.js` 中的 `replace()`（约 234 行）
支持替换单条记录或将多条同主题碎片合并为一条记录：
- **输入参数兼容**：
  - 接收 `memoryId`（单个 ID 字符串）或 `memoryIds`（ID 字符串数组，去重后 1～10 个）。
  - 统一归一化为 `targetIds` 数组（若为空或超过 10 个则抛错；若包含占位符如 `PLACEHOLDER` / `see summary` 则抛错）。
- **逐条预读校验**：
  - 对 `targetIds` 中的每个 ID 调用 `await read({ memoryId: id })`。
  - 若有任何一条返回 `null`，立即抛出明确错误：`未找到要合并/替换的旧记忆：${missingId}（请先通过 memory_search / memory_read 确认真实 memoryId）`，不执行后续写入。
- **元数据与证据合并**：
  - 默认继承主记录（`previousRecords[0]`）的 `origin`，若调用方显式传入 `origin` 则使用传入值。
  - 若调用方未显式传入 `tags` / `participants`，自动取所有旧记录 `tags` / `participants` 的去重并集（最多 20 项）。
  - 将所有旧记录的 `metadata.evidenceReferences` 与调用方新传入的 `evidenceReferences` 取去重并集（最多保留 20 项），防止合并后丢失原始证据链。
  - 设置新记录的 `metadata.supersedes`：若只有 1 条旧记录则存字符串 `targetIds[0]`（保持向后兼容），若有多条则存字符串数组 `targetIds`（或同时写入 `metadata.supersededIds = targetIds`）。
- **先写后删**：
  - 调用 `await save(...)` 保存合并后的新记录，获取 `newId = saved.storedIds[0]`。
  - 若 `!newId`，抛错中止，旧记录全部保留。
  - 依次对 `targetIds` 调用 `remove({ memoryId: id, reason })`（跳过可能等于 `newId` 的情况）。
  - 返回结构保持兼容并包含明细：
    ```js
    {
      memoryId: newId,
      replacedIds: deletedIds,
      oldMemoryRetained: retainedIds.length > 0,
      retainedIds,
      warning: warnings.join('；')
    }
    ```

#### 2. 在 `src/bridge.js` 中打通 Agent 端 `replace` 路由
- 在 `/api/desktop-agent/memory/:op` 处理分支（`src/bridge.js` 约 5181～5208 行）新增 `else if (operation === 'replace')`：
  ```js
  } else if (operation === 'replace') {
    result = await memoryGateway.replace({
      memoryId: body.memoryId,
      memoryIds: body.memoryIds,
      content: String(body.content ?? '').slice(0, 20_000),
      origin: body.origin || undefined,
      metadata: body.metadata,
      tags: body.tags,
      participants: body.participants,
      observedAt: body.observedAt,
      externalId: body.externalId,
      reason: body.reason || 'Consolidated by desktop agent'
    });
  }
  ```
- 同时在 `/api/memory/replace`（WebUI 路由，约 4006 行）支持传入可选的 `memoryIds`。

#### 3. 在 `src/mcp-memory-safe.js` 注册 `memory_replace` 工具
- 在 `src/mcp-memory-safe.js`（约 123 行之后）注册 `memory_replace`：
  - **工具名称**：`memory_replace`
  - **功能说明**：用一条更新、更完整的高密度记忆替换或合并 1～10 条已有的旧记忆（适用于：对已有课题补充新钻研收获、把同一话题/同一来源下的多条零散碎片合并成一条完整笔记、或更正已过时的旧事实）。调用前必须先通过 `memory_search` / `memory_read` 确认旧记录的真实 `memoryId` 与内容；不同 QQ 群或私聊的记忆严禁跨来源合并。
  - **参数 Schema**：
    - `memoryIds`：`z.union([z.string().min(1).max(300), z.array(z.string().min(1).max(300)).min(1).max(10)])`（支持传单个 ID 或 ID 数组，也可兼容 `memoryId` 字段）
    - `content`：`z.string().min(1).max(20000)`（合并/更新后的完整记忆正文，需保留原有关键事实与来源上下文）
    - `origin`：`z.enum(['qq', 'assistant']).optional()`
    - `tags`、`participants`、`observedAt`、`sourceContext`、`confidence`、`evidenceReferences`、`externalId`、`reason`（与 `memory_save` 保持一致）。
- 在 `src/memory-organizer-tool-guard.mjs` 第 4 行的 `ALLOWED` 列表中加入 `'memory_replace'`。

#### 4. 更新固定前缀提示词（引导“写前先查、同题合并升级”）
- 编辑 `dsh/agent-presets/desktop-agent/prompt-modules.json` 中的 `memory` 模块：
  - 引导数字角色在沉淀钻研笔记（`origin="assistant"`）或更新认知前，先用 `memory_search` 看一眼是否已有同课题/同事项的旧记录；
  - 若已有零散、重复或半截的旧笔记，优先用 `memory_read` 读出后，调用 `memory_replace` 将新旧干货融合成一条结构清晰的完整笔记，避免同一话题散落多条碎片挤占检索窗口。
- 修改后运行以下命令同步预设与补丁文件：
  ```powershell
  node -e "import fs from 'node:fs'; import { composePresetPromptModules, renderPresetPromptYaml } from './src/preset-prompt.js'; const modules = JSON.parse(fs.readFileSync('dsh/agent-presets/desktop-agent/prompt-modules.json','utf8')); const cordisFile = 'dsh/agent-presets/desktop-agent/agent.cordis.yml'; const cordis = fs.readFileSync(cordisFile,'utf8'); fs.writeFileSync(cordisFile, renderPresetPromptYaml(cordis, composePresetPromptModules(modules)), 'utf8');"
  node scripts/build-agent-preset-patches.mjs
  ```

---

### Phase 3：增强独立记忆整理器（`memory-organizer`）支持合并去重

**涉及文件**：`src/bridge.js`（约 2100～2740 行）

1. **更新 `MEMORY_ORGANIZER_SYSTEM_PROMPT`（`src/bridge.js` 约 2100～2114 行）**：
   - 引导整理器在准备写入记忆前，先用 `memory_search` 检索是否已有同主题、同来源（相同 `sourceContext` 或同属 `origin="assistant"` 同一课题）的旧记录；
   - 若发现已有零散碎片记录或当事人明确更正了旧信息，先调用 `memory_read` 核实旧记录原文，随后调用 `memory_replace` 将新旧信息合并提炼为一条完整记录（或用 `memory_save` 配合 `supersedes`）。
   - 再次强调：不同 QQ 群聊、私聊之间严禁合并；未通过 `memory_read` 核实的 `memoryId` 严禁传入 `memory_replace`。
2. **让整理器回执校验支持 `memory_replace`（`src/bridge.js` 约 2418～2455 行、2675～2730 行）**：
   - 目前整理器流式事件监控仅识别 `tool === 'memory_save'` 的成功回执（检查 `storedIds` / `skippedIds`）。
   - 将 `tool === 'memory_replace'` 一并纳入有效写入工具监控，并在 `memoryOrganizerSaveResult(event)`（约 2526 行）中识别 `memory_replace` 返回的 `memoryId`（将其视作有效落盘回执），确保整理器使用 `memory_replace` 时同样能通过回执校验并推进分段游标。

---

## 四、测试与验证清单

完成代码修改后，请依次运行以下测试脚本，确保现有契约与新增能力全部通过：

1. **长期记忆 Gateway 与 MCP 单元测试**：
   - 在 `scripts/test-audit-security-mcp.mjs` 或独立测试脚本中新增用例：
     - 验证 `memoryGateway.search()` 会自动过滤掉 `memoryId` 被其他命中项 `metadata.supersedes`（单字符串及数组）指向的旧记录；
     - 验证 `memoryGateway.replace()` 支持传入 `memoryIds: ['id1', 'id2']`，会先校验旧记录存在、合并 `evidenceReferences`、写入新记录后再删除 `id1` 和 `id2`；
     - 验证当任一旧 `memoryId` 不存在（404）时，`replace()` 拒绝写入且不会误删其余旧记录；
     - 验证 `mcp-memory-safe.js` 暴露了 `memory_replace` 工具且参数校验正常。
   - 运行：
     ```powershell
     node --test scripts/test-audit-security-mcp.mjs
     ```
2. **独立记忆整理器回归测试**：
   ```powershell
   node --test scripts/test-memory-organizer.mjs
   ```
3. **预设提示词、工具守卫与前端静态检查**：
   ```powershell
   node scripts/test-tool-restrict-guard.mjs
   node --test scripts/test-preset-local-tools.mjs scripts/test-preset-prompt.mjs scripts/test-console-static.mjs
   node scripts/test-agent-preset-patches.mjs
   ```
4. **文档同步检查**：
   - 实现完成后，同步更新 `docs/guides/MEMORY_ARCHITECTURE.md` 中关于“四个 DSH 工具”及 `supersedes` / `memory_replace` 的说明。
