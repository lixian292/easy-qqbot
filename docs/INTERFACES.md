# qqbot 模块契约（并行开发必须遵守）

> 目的：让多人并行开发时接口稳定。**除特别说明外，所有函数均为 async、纯 Node ESM（只 import `node:*` 和相对路径），不新增第三方依赖。**
> 所有模块不得读写彼此内部文件；只通过本文件定义的接口协作。`configStore` 由 Lead 在 `host/app.js` 提供。

## 0. 共享约定

### 0.1 注入对象

```js
configStore = {
  get(): config,                       // 当前生效配置（host/config.js 的完整结构，同步读）
  public(): object,                    // 脱敏配置（appSecret 为空 + masked）
  async save(patchOrFull): {config, warnings},
  onChange(listener): () => void       // 配置保存后触发；返回取消订阅函数
}

logger = {
  debug(msg, detail?), info(msg, detail?), warn(msg, detail?), error(msg, detail?),
  recent(limit?): entry[], async flush()
}
```

### 0.2 通用数据结构

```js
ChatRef = { kind: 'c2c' | 'group', chatId: string, targetId: string }
// chatId: `c2c_<user_openid>` / `group_<group_openid>`；targetId 为发消息用的 openid

Attachment = { url: string, contentType?: string, filename?: string, width?: number, height?: number, size?: number }

InboundMessage = {
  kind: 'c2c' | 'group',
  chatId: string,
  targetId: string,          // c2c: user_openid；group: group_openid
  userId: string,            // c2c: user_openid；group: member_openid
  userName?: string,
  text: string,              // 已 trim；纯图片消息可能为 ''
  msgId: string,             // 事件 d.id，用于被动回复
  eventId?: string,          // payload 外层 id（如群事件）
  timestamp: number,         // ms
  attachments: Attachment[],
  rawType: 'C2C_MESSAGE_CREATE' | 'GROUP_AT_MESSAGE_CREATE',
  memberRole?: 'member' | 'admin' | 'owner'
}

ChatMessage = {
  role: 'user' | 'assistant',
  content: string,
  ts: number,
  userId?: string,
  userName?: string,
  msgId?: string,
  stickerTags?: string[]
}

StickerItem = {
  id: string,                // sha256 前 12 位
  hash: string,
  ext: string,               // jpg/png/gif/webp/bmp
  size: number,
  layer: 'library' | 'candidate' | 'negative' | 'trash',
  tags: string[],
  desc: string,
  useCount: number,
  createdAt: number,
  updatedAt: number,
  lastUsedAt?: number,
  source?: { chatId?, userId?, userName?, msgId?, path?, url? }
}

Usage = { inputTokens: number, outputTokens: number, totalTokens: number, cost: number }

BudgetCheck = {
  allowed: boolean,
  reason: 'ok' | 'disabled' | 'daily' | 'monthly' | 'chat' | 'calls',
  usage: { calls, inputTokens, outputTokens, totalTokens, cost },
  limits: { dailyTokens, monthlyTokens, perChatDailyTokens, dailyCalls }
}

LlmResult = {
  text: string,
  usage: { inputTokens, outputTokens, totalTokens },
  provider: string,
  model: string,
  finishKind: string
}
```

### 0.3 文件所有权（写入范围）

| 负责人 | 可写文件 |
|---|---|
| Lead | `package.json` `cordis.patch.yml` `index.js` `icon.svg` `locale/**` `README.md` `docs/**` `host/index.js` `host/app.js` `host/config.js` `host/paths.js` `host/util/**` `host/admin/**` `tools/check.mjs` `tests/app-*.test.mjs` |
| gateway-dev | `host/qq/**` `tests/qq-*.test.mjs` |
| brain-dev | `host/brain/**` `host/memory/**` `host/budget/**` `host/persona/**` `tests/brain-*.test.mjs` `tests/memory-*.test.mjs` `tests/budget-*.test.mjs` |
| sticker-dev | `host/stickers/**` `tools/sticker-import.mjs` `tools/migrate-old.mjs` `tests/sticker-*.test.mjs` |

> 只改自己范围内的文件。需要改共享文件时先在任务里说明，由 Lead 处理。

## 1. host/budget/store.js

```js
export function createBudgetStore({ paths, configStore, logger })
```

| 方法 | 说明 |
|---|---|
| `async check({ chatId, userId })` | 依据当日/当月/该会话用量 + 配置限额返回 `BudgetCheck`。`budget.enabled=false` 时 `allowed:true, reason:'disabled'`。限额为 0 表示不限制该项。 |
| `async record({ chatId, userId, provider, model, usage })` | `usage={inputTokens,outputTokens}`；累加当日、当月、该会话、该用户；计算 cost（`priceInPerMillion/priceOutPerMillion` 按每百万 token 计价）；追加 `data/budget/events.jsonl`（含 ts/provider/model/tokens/cost/chatId/userId）；返回 `Usage` |
| `async snapshot()` | `{ date, month, today:{calls,inputTokens,outputTokens,totalTokens,cost}, month:{...}, chats:[{chatId,calls,totalTokens,cost,lastAt}], limits, currency }` |
| `async recent(limit=50)` | 最近调用明细（新→旧） |
| `async reset(scope='today')` | `'today' \| 'month' \| 'all'`；返回 snapshot |
| `async flush()` | 等待落盘 |

存储：`data/budget/usage.json`（详见 ARCHITECTURE）。保留最近 62 天、24 个月；写操作串行化、原子写。要能容忍损坏的 JSON（损坏时备份为 `.corrupt-<ts>` 并重建，记 warn 日志）。

## 2. host/persona/store.js

```js
export function createPersonaStore({ paths, configStore, logger })
```

| 方法 | 说明 |
|---|---|
| `async init()` | 载入 `data/personas.json`，缺省返回空结构 |
| `async resolve({ chatId, userId, kind })` | 合成有效人设：`{name, systemPrompt, style, replyMaxChars, stickerChance, memoryEnabled, compressEnabled, model?, temperature?, extraPrompt?}`。优先级：用户覆盖 > 会话覆盖 > `config.persona`。`kind` 仅用于记录。 |
| `async get(chatId)` | 会话覆盖或 `null` |
| `async set(chatId, patch)` | 局部更新；`null/''` 表示删除该字段；全部为空则删除覆盖。返回新覆盖或 `null` |
| `async setUser(userId, patch)` | 同上，用户级 |
| `async remove(chatId)` / `async removeUser(userId)` | 删除覆盖 |
| `async list()` | `{ chats: { [chatId]: patch }, users: { [userId]: patch } }` |
| `async flush()` | 落盘 `data/personas.json` `{version:1, chats, users}` |

## 3. host/memory/store.js

```js
export function createMemoryStore({ paths, configStore, logger })
```

| 方法 | 说明 |
|---|---|
| `async init()` | 确保目录存在；惰性加载 |
| `async getChat(chatId)` | `{ id, history: ChatMessage[], summary: {text, coveredCount, updatedAt} \| null, facts: [{id,text,createdAt,source?}], counters:{userMessages, lastExtractAt}, title, createdAt, updatedAt }`；不存在则返回空结构（不落盘） |
| `async appendMessage(chatId, message)` | 追加 history JSONL；更新 counters（role=user 时 userMessages+1）；更新 updatedAt/title |
| `async history(chatId, limit?)` | 最近 N 条（旧→新），不传 limit 用 `config.memory.historyLimit` |
| `async replaceHistory(chatId, messages)` | 压缩后重写 history.jsonl |
| `async setSummary(chatId, summary)` | 写 `summary.json` |
| `async addFacts(chatId, facts)` | `facts: string[]` 或 `[{text,source?}]`；去重（忽略大小写/空白）、截断到 `config.memory.maxFacts`，写 `memory.json` |
| `async setFacts(chatId, facts)` | 覆盖 |
| `async listChats()` | `[{chatId,title,kind,messageCount,userMessages,lastAt,summaryChars,factsCount}]`，按 lastAt 倒序 |
| `async clearChat(chatId, {keepFacts=true})` | 清空历史与摘要；默认保留 facts |
| `async getPerson(openid)` | `{id, name?, facts:[], messageCount, lastSeen, createdAt}` 或 `null` |
| `async upsertPerson(openid, patch)` | patch: `{name?, addFacts?, messageCount?}`；返回 person |
| `async listPeople()` | 按 lastSeen 倒序 |
| `async flush()` | 落盘所有脏数据 |

文件：`data/chats/<encodeURIComponent(chatId)>/history.jsonl|summary.json|memory.json|state.json`、`data/people/<openid>.json`。写入串行化、原子替换 JSON；history 允许 append。

## 4. host/memory/extract.js

```js
export function createMemoryExtractor({ configStore, llmClient, memoryStore, logger })
```

| 方法 | 说明 |
|---|---|
| `async maybeExtract({ chatId, force=false })` | 距上次抽取的 userMessages 增量 ≥ `config.memory.extractEveryUserMessages` 或 force 时抽取；返回 `{ extracted: boolean, facts: string[] }` |
| `async extractNow(chatId)` | 强制抽取 |

抽取逻辑：取该会话最近 20 条消息（含摘要），用 `llmClient.complete()` 让模型输出 JSON 字符串数组（最多 3 条、每条不超过 60 字、只记长期有价值的事实），容错解析（去掉 ```json 围栏、找第一个 `[`…最后一个 `]`）；失败只记 warn 日志，不抛错。成功后 `memoryStore.addFacts()`；可同时 `upsertPerson(userId)` 把关于用户的 facts 写入 people。system prompt 自己定义（中文）。

## 5. host/memory/compress.js

```js
export function createCompressor({ configStore, memoryStore, llmClient, logger })
```

| 方法 | 说明 |
|---|---|
| `async maybeCompress(chatId)` | 估算「摘要 + 最近 history」token（`estimateTokens`）；超过 `config.memory.compressTriggerTokens` 时压缩：保留最近 `keepRecentMessages` 条，把更早的消息并入旧摘要重新总结；返回 `{ compressed, removed, summary }` |
| `async compressNow(chatId)` | 无条件压缩（无更早消息时返回 `{compressed:false, removed:0}`） |

摘要用 `llmClient.complete()` 生成，长度 ≤ `config.memory.summaryMaxChars`；更新 `memoryStore.setSummary()` 与 `replaceHistory()`。压缩失败时回滚（不改历史、不抛错，返回 `{compressed:false, error}`，记 warn）。

## 6. host/brain/llm.js

```js
export function createLlmClient({ ctx, configStore, logger })
export class LlmCallError extends Error { code: string; cause?: unknown }
```

| 方法 | 说明 |
|---|---|
| `async complete({ system, messages, maxTokens?, temperature?, purpose?, signal? })` | messages: `[{role:'user'\|'assistant'\|'system', content: string}]`。调用 `ctx.llm.stream({provider, model, system, messages, temperature, maxTokens, ...(purpose?{purpose}:{}), signal})`，收集 `text-delta`/`block-end` 文本、`usage` 分片、`finish` 分片，返回 `LlmResult`。失败 finish 或抛异常 → 抛 `LlmCallError`（code 取 failure.code，缺省 `LLM_ERROR`）。超时用 `config.llm.timeoutMs` 触发 AbortController（外部 signal 也要联动）。空文本视为 `EMPTY_RESPONSE`。 |
| `async test({ prompt='你好' } = {})` | 便捷自检：`complete({system:'你是连通性测试助手，只回复一行。', messages:[{role:'user',content:prompt}], maxTokens:64})` |

注意：DeepSeek 适配器要求 assistant 消息带 `source: { kind:'model', provider, model }`；转换时补上，user 消息不需要。chunk 形状：`{type:'text-delta',text}`、`{type:'block-end',block:{type:'text',text}}`、`{type:'usage',usage:{...}}`、`{type:'finish',reason:{kind}}`。

## 7. host/brain/prompt.js（纯函数）

```js
export function buildSystemPrompt({ config, persona, facts, summary, stickerCatalog, now = Date.now() })
export function buildMessages({ history, userMessage, maxMessages })
export function buildStickerInstruction({ stickerCatalog, stickerChance })
```

- system prompt 包含：人设（`persona.systemPrompt`）、风格（`persona.style`）、名字、当前时间、长期记忆事实、上下文摘要、表情包标签目录与指令说明（当 `config.stickers.enabled` 且目录非空）。
- 表情包指令格式固定为 `[[sticker: 标签1, 标签2]]`（也接受 `[[表情: ...]]`），仅当合适时使用；标签必须来自目录。
- `buildMessages` 把 history（ChatMessage）转成 `{role, content}`，超过 maxMessages 取最近；末尾追加 `{role:'user', content:userMessage}`。
- 全部输出纯文本，禁止 Markdown。

## 8. host/brain/commands.js

```js
export function createCommandHandler({ configStore, budgetStore, memoryStore, stickerStore, stickerSelector, logger })
```

| 方法 | 说明 |
|---|---|
| `async tryHandle(inbound)` | 识别命令并返回 `{handled:true, text?:string, sticker?:StickerItem}`；非命令返回 `{handled:false}` |

命令（大小写不敏感；前缀取 `config.commands.prefix`，默认 `#`，同时兼容 `/`、`／`）：

- `#帮助` / `#help`：列出所有命令。
- `#预算` / `#budget`：返回今日/本月/本会话 token 与费用（`{totalTokens, cost, currency}`），普通用户可看自己的会话。
- `#表情 <标签...>` / `#sticker <tags>`：从表情包库随机挑选匹配项；无匹配返回提示；返回 `{handled:true, sticker, text?}`。
- `#清空上下文`：清空本会话历史与摘要（保留长期事实），返回确认文案。
- `#记忆`：列出本会话长期事实（最多 10 条），无则提示。
- `#状态` / `#status`：管理员命令（`config.commands.adminOpenids` 包含 userId，或群 `memberRole` 为 owner/admin 且 `allowGroupOwner` 打开），返回连接状态摘要（由 `ctx` 无关的轻量信息组成：预算、会话数、表情包数）。
- `#表情包统计`：管理员命令，返回各图层数量与标签 TopN。
- 未知命令返回 `{handled:false}`（交给 LLM 正常回答，避免群里误拦截）。

## 9. host/brain/chat.js

```js
export function createChatEngine({
  configStore, personaStore, memoryStore, budgetStore, llmClient,
  compressor, extractor, stickerStore, stickerSelector, commandHandler,
  qqClient, logger, captureIncomingImage
})
```

| 方法 | 说明 |
|---|---|
| `async handleInbound(inbound)` | 处理一条入站消息。内部按 chatId 串行（promise map），不抛错（错误记日志并尽量回一句兜底文案）。 |
| `async compressChat(chatId)` | 管理页用：强制压缩，返回 compressor 结果 |
| `async extractFacts(chatId)` | 管理页用：强制抽取事实 |

`captureIncomingImage(attachment, inbound)` 是可选注入函数（Lead 在 app.js 用 importer 实现），负责把入站图片抓进表情包候选库；实现里要防御 undefined。

处理流程（严格按此实现，便于测试）：

1. `commandHandler.tryHandle(inbound)`；handled 则发 text/sticker 后返回。
2. 入站图片：若 `config.stickers.enabled && config.stickers.captureIncoming`，对每个 attachment 触发 `stickerStore.captureFromUrl?` —— **由 chat.js 调用注入的 `captureIncomingImage`（可选函数）**，失败只记日志；并把 `[图片]` 写入用户消息内容。
3. `budgetStore.check({chatId, userId})`；`allowed=false` 时：若距上次提示超过 `budget.blockCooldownMs`，发 `config.budget.blockMessage`；把用户消息与提示写入 memory；返回。
4. `memoryStore.appendMessage(chatId, {role:'user', content, ts, userId, userName, msgId})`。
5. 压缩：若 `persona.compressEnabled` → `compressor.maybeCompress(chatId)`。
6. 组装：`history = memoryStore.history(chatId, persona.maxHistoryMessages)`；facts = chat.facts；summary；stickerCatalog = `stickerSelector.catalogText()`；`system = buildSystemPrompt(...)`；`messages = buildMessages(...)`。
7. `llmClient.complete()`；成功 → `budgetStore.record()`；失败 → 记 warn，发一次兜底错误文案（"我这边刚刚走神了，再说一次？"），返回。
8. 解析 `parseStickerDirectives(text)`；清理 Markdown → `stripMarkdown`；截断到 `persona.replyMaxChars`。
9. 发送：先文字（如果有），再表情包：显式指令优先 `stickerSelector.pickForReply(tags)`；否则按 `stickerChance` 在回复文本命中标签时 `stickerSelector.maybeStickerFromText()`；发送失败降级为纯文字。
10. `memoryStore.appendMessage(chatId, {role:'assistant', content: finalText, ts})`。
11. 异步（不 await，catch 后仅记日志）：`extractor.maybeExtract({chatId})`。

## 10. host/stickers/store.js

```js
export function createStickerStore({ paths, configStore, logger })
```

| 方法 | 说明 |
|---|---|
| `async init()` | 载入 `data/stickers/index.json`；不存在则创建 `{version:1, items:[]}` |
| `list({ layer, tags, query, limit=60, offset=0 })` | `{ total, items }`，按 `updatedAt` 倒序；tags 为 AND 过滤；query 匹配 tags/desc/id |
| `get(id)` | item 或 `undefined` |
| `async addItem({ buffer, ext, tags, desc, layer='candidate', source })` | 计算 sha256；重复则合并 tags/desc 并返回 `{item, duplicate:true}`；写入 `data/stickers/<layer>/<id>.<ext>`；索引原子写。`buffer` 为 Buffer |
| `async update(id, { tags, desc, layer })` | 更新标签/描述；`layer` 变化时移动文件；返回 item；不存在抛 `Error('sticker not found: <id>')` |
| `async recordUse(id)` | useCount+1、lastUsedAt |
| `async pick({ tags, rng=Math.random })` | 从 `library`（若 `config.stickers.libraryOnly=false` 也含候选）挑：标签完全命中优先 > 命中个数 > 随机；无匹配返回 `null` |
| `async catalog({ maxTags } = {})` | `{ total, tags: [{tag,count}], byLayer: {library,candidate,negative,trash} }`，标签按出现次数倒序 |
| `async stats()` | `{ total, byLayer, tags: number }` |
| `filePath(item)` | 绝对路径（不存在也返回） |
| `async remove(id)` | 移入 trash 图层（可还原） |
| `async purge(id)` | 从索引与磁盘删除 |
| `async restore(id)` | trash → candidate |
| `async flush()` | 落盘 |

索引写操作串行化；`list/get/stats` 同步可读缓存 + async 语义皆可（建议全部 async 以统一）。

## 11. host/stickers/importer.js

```js
export function createStickerImporter({ paths, configStore, stickerStore, logger, fetchImpl })
export function isSupportedImageBuffer(buffer, ext)
export function extFromContentType(contentType)
```

| 方法 | 说明 |
|---|---|
| `async scanImportDir(dir?)` | 递归列出 `import/` 下的图片文件 `[{path,name,size}]`（默认目录 `paths.importDir`） |
| `async importDirectory({ dir?, tags=[], desc='', layer='candidate' })` | 扫描并逐个 `stickerStore.addItem()`；返回 `{ added:[], duplicates:[], skipped:[{path,reason}], errors:[] }` |
| `async importBuffers(files, { tags, desc, layer='candidate', source })` | files `[{name, buffer}]`；同上 |
| `async captureFromUrl({ url, contentType, source })` | 下载入站图片（超 `config.stickers.maxImageBytes` 跳过）→ `addItem` 到 candidate；返回 `{item, skipped?}`；网络失败抛错由调用方 catch |

支持格式：jpg/jpeg/png/gif/webp/bmp（用魔数判断，扩展名仅作辅助）。

## 12. host/stickers/selector.js

```js
export function createStickerSelector({ stickerStore, configStore, logger })
```

| 方法 | 说明 |
|---|---|
| `async pickForReply(tags)` | 解析指令标签 → `stickerStore.pick({tags})`；无匹配再放宽为任意单个标签重试 |
| `async catalogText()` | 生成提示词用目录字符串：`标签(count)、…`（仅 library，最多 `config.stickers.maxCatalogTags` 个；空库返回 `''`） |
| `async maybeStickerFromText(text, rng=Math.random)` | 若 `stickerChance` 命中且回复文本包含某个 library 标签 → 随机挑一个；否则 `null` |

## 13. host/qq/api.js

```js
export function createQQApi({ configStore, logger, fetchImpl })
export class QQApiError extends Error { code; status; errCode; traceId }
```

| 方法 | 说明 |
|---|---|
| `async getToken({ force=false } = {})` | POST `{apiBase}{tokenPath}`，body `{appId, clientSecret}`；缓存 token 到提前 60s 过期；返回 `{accessToken, expiresIn, fetchedAt}`。失败抛 QQApiError（含 err_code）。 |
| `async request({ method='GET', path, query, body, auth=true, timeoutMs=15000 })` | 统一请求：`Authorization: QQBot <token>`，JSON 解析；HTTP 非 2xx 或 body 有 `err_code` 非 0 时抛 QQApiError（保留 code/status/traceId）。204 返回 `{}`。 |
| `async getGatewayUrl()` | GET `{gatewayPath}` → `url` 字符串 |
| `async uploadMedia({ kind, targetId, buffer, fileName, fileType=1 })` | POST `/v2/{groups|users}/{targetId}/files`，body `{file_type, file_name, file_data: base64}`；返回 `{fileInfo, fileUuid, ttl, rawUrl}`。>5MB 抛错 `MEDIA_TOO_LARGE`。 |
| `async sendText({ kind, targetId, content, msgId, msgSeq, eventId })` | POST `/v2/{groups|users}/{targetId}/messages` body `{msg_type:0, content, ...(msgId?{msg_id,msg_seq}:{}) , ...(eventId?{event_id}:{})}`；返回响应。 |
| `async sendImage({ kind, targetId, fileInfo, msgId, msgSeq })` | POST 同上 body `{msg_type:7, media:{file_info}, ...}` |
| `async getBotMe()` | GET `/users/@me`，返回 bot 信息；失败返回 null |
| `invalidateToken()` | 清缓存 |

`apiBase` 默认 `https://api.bot.qq.com`；每次调用从 `configStore.get()` 读取（设置页改完无需重启模块）。请求超时/网络错误转 QQApiError(code: 'NETWORK'|'TIMEOUT'|'HTTP_<status>')。

## 14. host/qq/inbound.js

```js
export function normalizeDispatch(t, d) // → InboundMessage | SystemEvent | null
export function createEventDedupe({ maxSize = 500 } = {}) // → { seen(key): boolean }
```

- `C2C_MESSAGE_CREATE`：`author.user_openid` / `author.id`；`text = (content ?? '').trim()`。
- `GROUP_AT_MESSAGE_CREATE`：`group_openid`、`author.member_openid`、`author.member_role`。
- attachments 归一化：`{url, contentType: content_type, filename, width, height, size}`。
- 系统事件：`FRIEND_ADD/FRIEND_DEL/GROUP_ADD_ROBOT/GROUP_DEL_ROBOT/...` → `{kind:'system', type:t, timestamp, data: d}`。
- 其他事件返回 `null`。
- `createEventDedupe` 基于 (t + d.id) 去重，返回 `seen()`：首次 false，重复 true；LRU 淘汰。

## 15. host/qq/outbound.js

```js
export function createSender({ api, configStore, logger })
export function chatTarget(chat) // chat: {kind, targetId}
```

| 方法 | 说明 |
|---|---|
| `async sendText(chat, text, { replyTo } = {})` | 清洗 Markdown、按 `config.qq.textChunkSize` 分片；每片更新 msg_seq；`replyTo = {msgId, receivedAt, kind}` 在窗口内且次数未超时带 `msg_id/msg_seq` 被动回复，否则主动消息（不带 msg_id）。返回 `{ ids: string[], passive: boolean }` |
| `async sendImage(chat, { buffer } \| { filePath }, { replyTo } = {})` | 上传 → `file_info` 缓存（同 target+内容指纹+ttl）→ 发 msg_type 7；返回 `{ id }` |
| `async sendSticker(chat, stickerItem, { replyTo } = {})` | 读取 `stickerStore.filePath`（由调用方传 `{filePath}` 更简单：`sendSticker(chat, {filePath, id}, {replyTo})`） |
| `async sendTyping(chat)` | 可选（c2c msg_type 6，失败静默） |

窗口/次数来自 `config.qq.reply`；同一 msgId 的回复计数保存在内存 Map（TTL 清理）。

## 16. host/qq/gateway.js

```js
export function createGateway({ api, configStore, logger, onDispatch, onStatusChange, WebSocketImpl = globalThis.WebSocket })
export function buildIdentifyPayload({ accessToken, intents, shard })
export function buildResumePayload({ accessToken, sessionId, seq })
export function buildHeartbeatPayload(seq)
export function nextBackoffMs(attempt, { baseDelayMs, maxDelayMs })
export function isResumableCloseCode(code)
```

| 方法 | 说明 |
|---|---|
| `async start()` | 获取 gateway url → 建连；收到 Hello(10) 后发 Identify(2)（有 sessionId+seq 则发 Resume(6)）；启动心跳定时器；`onStatusChange(status)` 每次状态变化回调。已在运行时幂等。 |
| `async stop({ clearSession=false } = {})` | 关闭 socket、清定时器；clearSession 时清 session_id/seq |
| `status()` | `{ state:'idle'|'connecting'|'online'|'reconnecting'|'offline', connectedAt, lastHeartbeatAt, lastEventAt, sessionId, seq, bot, lastError, attempts }` |
| `async reconnect()` | 手动重连（先 stop 保留 session） |

行为要求：
- op 10 Hello → 存 heartbeat_interval → identify/resume；op 0 READY/RESUMED 更新 session/bot 状态；op 11 心跳 ack；op 7 立即重连；op 9 清 session 后重连（重新 identify）；op 1 服务端心跳请求要回心跳。
- 心跳：按 interval 发 `{op:1, d: lastSeq}`（首次 null）；定时器出错不能崩溃。
- 重连：指数退避 `nextBackoffMs`，`config.qq.reconnect.maxAttempts=0` 表示无限；stop 后不再重连。
- dispatch 事件：把 `{t,d,s,id}` 传给 `onDispatch`，内部对 READY/RESUMED 先更新状态再回调可选；业务 dedupe 由 qq/index.js 负责。
- 所有 socket 事件处理必须 try/catch，错误通过 `onStatusChange`/logger 暴露，绝不能抛到进程。

## 17. host/qq/index.js

```js
export function createQQClient({ ctx, configStore, logger, onInbound })
```

| 方法 | 说明 |
|---|---|
| `async start()` | `config.enabled=false` 或凭据缺失 → 状态 `standby`，不报错；否则建 api+gateway+sender 并 start |
| `async stop()` | 停止并对 sender 内部缓存清理 |
| `async restart()` | 用于配置保存后：stop → 重新读取配置 → start |
| `status()` | gateway 状态 + `{enabled, hasCredentials, sent, received, lastInboundAt, bot}` |
| `async sendText(chat, text, opts)` / `async sendImage(chat, media, opts)` / `async sendSticker(chat, sticker, opts)` | 委托 sender；未连接时抛 `Error('QQ bot is not connected')` |
| `async testAuth()` | 取 token + gateway url，返回 `{ ok, tokenExpiresIn, gatewayUrl, bot? }`（不打印 token） |
| `async sendTyping(chat)` | 可选透传 |

`onInbound(dispatch)` 收到归一化后的 `InboundMessage | SystemEvent`（gateway 的所有 dispatch 事件都转发；由 qq/index 调用 `normalizeDispatch`）。内部对 `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` 做 eventId+msgId 去重，重复丢弃。

## 18. Admin（Lead 实现，仅说明依赖关系）

管理后台是 `host/admin/**`，通过 `host/app.js` 注入以下对象，不直接 import 其他模块内部文件：
`{ ctx, paths, configStore, qqClient, llmClient, budgetStore, personaStore, memoryStore, stickerStore, importer, selector, chatEngine, logger, version }`。

暴露 HTTP：`GET <admin.path>`（页面）、`GET <admin.path>/assets/*`（静态）、`GET <admin.path>/media/sticker/<id>`（图片）、`POST <admin.path>/api`（`{method,args}` → `{ok,result|error}`，同源校验）。

## 19. 测试要求（每个人）

- 用 `node --test tests/<你的前缀>-*.test.mjs`，不联网、不依赖真实 QQ。
- 覆盖：正常路径 + 至少 2 个错误/边界路径。
- 涉及文件系统的测试必须用 `QQBOT_DATA_DIR=<临时目录>`（每个测试文件独立 `mkdtemp`），结束后清理。
- mock：LLM 用 async generator 的假 `ctx.llm`；HTTP 用注入 `fetchImpl`；WebSocket 用注入 `WebSocketImpl`（提供最小 fake）。
- 所有 JS 通过 `node --check`。
