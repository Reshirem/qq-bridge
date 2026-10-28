# 发布前隐私检查（PRIVACY）

> 这个项目在一台**真实机器**上运行过，工作树里天然散落着真实 QQ 号、群号、本机绝对路径、
> 令牌、以及个人化的人格卡内容。任何一次「忘了就 push」都会把这些**永久写进公开仓库历史**
> ——Git 历史里的东西删提交也删不干净（还会被 fork 保留）。
>
> 所以发布前跑一遍扫描，是发布流程的**硬性一步**，不是可选建议。

---

## 一、跑扫描

```bash
node scripts/privacy-scan.mjs                # 扫"将要提交的内容"（推荐）
node scripts/privacy-scan.mjs --tracked-only # 只扫 git 已跟踪文件
node scripts/privacy-scan.mjs --json         # 机读输出（给 CI 用）
```

退出码：`0` = 干净，`1` = 有命中（**必须逐个判读**），`2` = 规则文件坏了或目录扫不动。

它扫描：`git ls-files` + 未被 ignore 的未跟踪文件（git 不可用时退化为目录遍历，并尽力套用 `.gitignore`；
遍历会跳过 junction/symlink，免得被指回自身的联接搞成无限递归）。

## 二、内置规则（挡住最常见的泄漏）

| 规则 | 说明 |
| --- | --- |
| 本机绝对路径 | `C:\Users\<名字>\…` 与 `D:\<工作盘>\…` 这类工作盘路径 |
| QQ 号 / 群号 | 9–10 位连续数字（真实账号长度；文档里的 `123456789` 属占位符） |
| 高熵串 | 疑似令牌/密钥。**过滤掉**全 hex（git SHA）、全大写下划线（环境变量名）、小写文件名式串 —— 真凭据是"大小写+数字混合" |
| 凭据赋值 | `accessToken: "<12 位以上实际值>"` 形态（空值/模板不算，避免噪音） |
| 私钥头 / 带凭据的 URL | `-----BEGIN … PRIVATE KEY-----`、`https://user:pass@host` |
| 不应入库的文件 | `config.json`、`state/`、`audio/`、`*.log`、`*.bak*` |

### 长期记忆

- A_Memorix 的记忆正文、QQ 来源证据和自身经历由单独部署的 A_Memorix 服务持久化；它们不会写入 qq-bridge 仓库。`memory.apiKey` 只保存在本地、被忽略且 ACL 收紧的 `config.json`；Embedding/LLM Provider 密钥保存在被忽略、ACL 收紧的 `state/a-memorix/secrets/`，WebUI 不回显密钥。Provider 地址、模型与密钥由用户在 WebUI 手动配置。
- 桥接只向本机回环 Gateway 发送显式提交的记忆内容和按需检索词。A_Memorix 后端可能将内容交给部署配置中的 Embedding/LLM Provider；配置者应按该服务与 Provider 的数据处理规则决定是否启用。
- WebUI 和 DSH 工具参数都可能包含个人记忆。桥接工具调用审计省略记忆工具参数，但 DSH 自身的持久会话事件仍可能保存工具调用与结果；不要把 A_Memorix 服务日志、备份或真实记忆样本提交到仓库。

## 三、判读命中：三种处理，别一律"忽略"

| 情况 | 处理 |
| --- | --- |
| **真实数据**（你的 QQ 号、群号、本机路径、令牌） | 换成占位符（`123456789` / `C:\path\to\…`），或把该文件移出版本控制 |
| **该文件本来就不该入库** | 加进 `.gitignore`；若已提交过，见下面第四节 |
| **误报**（脱敏模板、测试夹具、文档示例） | 加进白名单 —— 两种方式：<br>① 文件级：`scripts/privacy-rules.json` 的 `allowPaths`；<br>② 规则级：在同一文件里加一条更精确的 `deny` 规则覆盖默认规则 |

### `scripts/privacy-rules.json`（可选的本地规则文件）

- **它含你机器上的真实标识，必须加进 `.gitignore`**（模板见 `privacy-rules.example.json`）。
- 结构：

```jsonc
{
  "comment": "本机专用；不入库",
  "deny": [
    { "name": "我的真实群号", "pattern": "1001[0-9]{6}", "flags": "" }
  ],
  "denyFiles": ["notes/", "*.private.md"],
  "allowPaths": ["docs/guides/SECURITY_BASELINE.md", "scripts/console-ui-"]
}
```

`allowPaths` 支持前缀或 `*` 通配。**加入白名单前先确认那个文件里确实只有占位数据**——
白名单是"误报豁免"，不是"这个文件不用检查"。

## 四、已经提交进去了怎么办

| 情况 | 处理 |
| --- | --- |
| 还没 push | `git reset --soft` 回退提交、清掉敏感内容、重新提交 |
| 已 push，但**没有被 fork / 没人拉过** | `git filter-repo --replace-text` 清历史，再 `git push --force`。要提前通知协作者 |
| 已 push 且可能被 fork / 已公开一段时间 | **当作已泄露**：① 立刻**轮换**所有涉及的凭据（控制台令牌、SnowLuma token、DSH launch token 都是本地生成，轮换成本低）；② 再清理历史；③ 如需迁移到新仓库，从确认过的干净内容重新发布，不复制敏感历史 |

## 五、CI 里怎么用

```yaml
# .github/workflows/ci.yml 片段
- name: Privacy scan
  run: node scripts/privacy-scan.mjs --tracked-only
```

CI 上只扫**已跟踪**文件（未跟踪文件在干净 checkout 里不存在），命中即失败。

## 六、2026-09-20 历史扫描记录

> 以下只记录当时的扫描结果与迁移计划，不是当前文件清单。当前文档以 [docs/README.md](../README.md) 为准；当前待提交内容应重新运行隐私扫描。

首次运行发现的问题，供拆分新仓库时逐条处理：

| 文件 | 命中 | 处理建议 |
| --- | --- | --- |
| `public/console.html` | 真实群号 `100012` × 2 | **必须替换为占位符**（这是随仓库发布的文件） |
| `src/bridge.js` | `accessToken` 键名（配置读取处，无真实值） | 误报：键名不是值；已在规则里区分"有实际值" |
| 当时的本地项目/语音指南 | 真实 QQ 号/群号与本机绝对路径 | 未纳入公开仓库；这些旧文件不属于当前文档集 |
| 当时的本地审计、设计、调研和归档笔记 | 本机路径、真实 QQ 号 | 被 `.gitignore` 排除；当前文档索引不再链接它们 |
| `scripts/test-*`、`scripts/console-ui-*`、`src/sensitive.js`、`config.example.json` | 刻意构造的假 ID / 假凭据 / 占位符 | 误报：已在 `allowPaths` 白名单里 |

**历史结论**：当时必须在代码里改掉的是 `public/console.html` 中的群号；其余问题通过不发布本地文档解决。此结论不替代对当前改动的扫描。
