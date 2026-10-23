# 模型兜底按引擎分开（kiro / Claude Code / Codex）

三家的模型互不相通：Claude Code 只有 Claude（适配器 configOptions 实测 `default / sonnet / opus / haiku / global.anthropic.claude-fable-5-1`），
Codex 只有 OpenAI 的，kiro 的 id（`claude-opus-5`、`gpt-5.6-sol` …）对它们都不是合法值。所以 KiroLex 的「模型兜底 / 备用模型」整套
（`MODEL_FALLBACK_ORDER`、kiro-cli `--list-models` 清单、死模型表、`modelEarnedOn`、`preferredModel`、辅助模型）**只对 kiro 生效**；
Claude Code / Codex 只在**自己适配器报的**模型清单里兜底（`src/main/engineModelPick.ts`）。

## 审计表

「生效」= 对这种会话会不会跑到这段逻辑；「结论」里 ✅ = 原来就对、🔧 = 这次改了。

| 位置 | 作用 | kiro | claude | codex | 结论 |
|---|---|---|---|---|---|
| `config.ts` `MODEL_FALLBACK_ORDER` / `DEFAULT_MODEL` | kiro 降级链 / 新会话默认模型 | 生效 | 不生效 | 不生效 | ✅ 只被下面各处在 kiro 分支里读 |
| `index.ts` `connectWithModelFallback` | 按 `[preferredModel, 在这台机器挣来的 model, ...MODEL_FALLBACK_ORDER]` 依次起执行器；本机清单比对、写死模型表、「本机没有模型 X，改用 Y」 | 生效 | 跳过（`engine !== 'kiro'` 直接起适配器一次） | 跳过 | ✅ 不改 |
| `index.ts` `localModelIds`（`kiro-cli chat --list-models`） | 本机 kiro 清单 | 生效 | 不调用 | 不调用 | ✅ |
| `index.ts` `deadModelsFor` / `modelsKnownDead` | 本次运行里证实跑不了的 kiro 模型 | 生效 | 不读不写 | 不读不写 | ✅（写它的只有 `connectWithModelFallback` 的 kiro 分支和 `swapSessionModel`） |
| `index.ts` `swapSessionModel` + 一轮里 `isModelUnavailableError` → 换模型重发（`MAX_MODEL_SWAPS`） | 跑到一半模型退役时按降级链换 | 生效 | 跳过（`engineOf !== 'kiro'` 返回 null；调用处也判了 kiro） | 跳过 | ✅ 不改 |
| `index.ts` `pickRemoteModel` + `modelAvailability.ts` `firstWantedModel` / `remoteStartCandidates`（新建 / attach / 换机器 / 换引擎） | 远端 kiro 清单里挑模型、「{host} 上没有模型 X」 | 生效 | 跳过（这几处都是 `engine !== 'kiro' ? remoteAdapterCheck : pickRemoteModel`） | 跳过 | ✅ 不改 |
| `modelFallbackNote.ts` `ModelFallbackNotes` | 「改用了备用模型」只说实际起来的那个、同一对只说一次 | 生效 | 🔧 现在也用（见 `applyEngineModel`） | 🔧 同左 | 复用同一套去重 / 落盘机制 |
| `index.ts` `applyEngineModel`（连上后把 `engineModels[engine]` 设回去） | Claude Code / Codex 记住的模型 | 不走 | 🔧 原来：不在清单里就**静默跳过**（审计 1b）。现在：`pickEngineModel` 只在本适配器清单里挑「上次成功用的 → `default` → 当前值」，并在会话里说「这台机器上的 Claude Code 没有模型 X，这条会话改用 Y」 | 🔧 同左 | 候选只来自适配器 configOptions，不可能选出 kiro 的 id |
| `index.ts` `setEngineOption`（下拉里手选模型） | 写 `engineModels[engine]` | 不走 | 🔧 同时记 `engineModelsUsed[engine]`（「上次成功用的」） | 🔧 同左 | 不碰 `model` / `preferredModel` |
| `index.ts` `loadSessionImpl`（attach）建 profile | `model: 渲染层带来的 || 记录的 || DEFAULT_MODEL`；之后「persist effective model」把它连 `modelEarnedOn` 写进记录 | 生效 | 🔧 原来：渲染层带的是 kiro 的模型名（没记过就是 `claude-opus-5`），会被当成实际模型**写进 Claude 会话的记录**。现在：不采信渲染层的，用记录里的；那段写盘只对 kiro | 🔧 同左 | 老记录里的 kiro id 读着忽略，不迁移改写 |
| `index.ts` `acp:new-session` | 新会话 `model` / `preferredModel` | 渲染层给的或 `DEFAULT_MODEL` | 记 `'default'` 占位 | 记 `'default'` | ✅ 原来就对 |
| `App.tsx` `modelForNewChat` | 新建会话按 `kirolex-last-model` + kiro 兜底链挑一个 | 生效 | 🔧 原来也挑 kiro id 传下去（主进程会换成 `'default'`，但日志 / 新建失败时的参数里带着它）。现在：`newChatModel` 对 Claude / Codex 返回空 | 🔧 同左 | 抽成纯函数 `engineModelPick.ts` `newChatModel`，有测试 |
| `App.tsx` `selectedModel` / `kirolex-last-model`；`useAcp.ts` `sessionModelRef` | kiro 的模型下拉 / attach 带的模型 | 生效 | 下拉不显示（ChatArea `nonKiro` 走 `engineModels`）；attach 带的模型主进程现在忽略 | 同左 | ✅（主进程侧兜住，渲染层不改） |
| `index.ts` `acp:switch-model` / 忙时 pending 的 `model` / 组合切换 `carryIntoProfile` | 换 kiro 模型、写 `preferredModel` + `modelEarnedOn` | 生效 | 拒绝（「模型在它自己的 CLI 里配」）/ 只在最终引擎是 kiro 时写 | 同左 | ✅ 不改 |
| `index.ts` `reshapeForEngine`（换引擎） | 切到 kiro：用 `preferredModel`（是 `'default'` 就用 `DEFAULT_MODEL`）；切到另两家：`model = 'default'` | 生效 | `engineModels` / `engineOptions` 原样带着 | 同左 | ✅ 行为不变，抽成 `reshapeProfileForEngine`，补了「各引擎记住的互不覆盖」的测试 |
| `index.ts` `runLiteOneShot` + `loadHelperModels` + `helperModels.ts` `planHelperRoute`（辅助模型 / 备用） | 用 kiro-cli 一次性跑标题 / 追问建议 / 记忆整理；模型按本机 + 远端 kiro 清单挑，再退 `MODEL_FALLBACK_ORDER` | 生效 | 跳过（`skipLiteHelperFor` → `engines.ts` `liteHelperSkipReason`，会话里说一次） | 跳过 | ✅ 不把 kiro 模型名交给 Claude / Codex |
| `index.ts` `app:list-helper-models` + `SettingsDialog.tsx` 两个下拉 | 设置里「辅助模型」「辅助模型备用」 | 只列 kiro 清单（本机 + 远端） | — | — | 🔧 文案标明「由 kiro-cli 运行」「给 Kiro 会话」 |

## 选择：没有 kiro 的用户，标题 / 追问建议怎么办

**直接跳过**（不改用会话自己的引擎跑一次轻量请求）。理由：

- 改动最小：现有 `liteHelperSkipReason` 已经对 Claude Code / Codex 会话跳过并在会话里说一次（「标题取第一条消息、会话记忆可以手动编辑」），
  只装了 Claude Code / Codex 的用户也只会有这两种会话 —— 不需要再判断「本机和远端有没有 kiro-cli」。
- 不额外花钱：改用会话自己的引擎意味着每轮再起一次 Claude / Codex 请求，记在用户自己的额度上，而且要另做适配器的一次性调用路径。
- 不会拿 kiro 的模型名去调 Claude / Codex：辅助调用只走 kiro-cli。

## Claude Code / Codex 记住的模型不在清单里

`pickEngineModel(engine, 记住的, 上次成功用的, 适配器的 model 选项)`：

1. 记住的在清单里 → 设它（没变就不发）。
2. 不在 → 依次挑清单里有的：上次成功用的 → `default` → 适配器当前值 → 清单第一个；设上之后在会话里说一句
   （`ModelFallbackNotes`，同一对只说一次，又用上记住的那个后再换才会再说）。`engineModels` 里记住的那个**不改**：换到有它的机器 / 适配器升级后还会先试它。
3. 不管是 1 还是 2，适配器接受了（或本来就是）的那个都记成「上次成功用的」（`profile.engineModelsUsed`）——兜底挑中的也记，换到有它的机器时先退回它。设失败就不记。
4. 没记过 / 适配器没报清单 → 什么都不做。

kiro 的 `model` / `preferredModel` / `modelEarnedOn` / 死模型表在这条路上一概不读不写。
