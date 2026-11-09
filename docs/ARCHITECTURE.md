# qqbot 架构说明

> 本插件是 DeepSeek Harness（DSH）的本地 bundle：把 QQ 官方机器人接入 DSH，
> 使用 DSH 已配置的 LLM（`ctx.llm`）生成回复，并自带预算控制、记忆、上下文压缩、
> 个性化配置与表情包系统。**所有代码、配置和运行数据都在 `qqbot/` 目录内。**

## 1. 目录结构

```
qqbot/
├── package.json             # DSH bundle 清单（dsh.bundle.patch）
├── cordis.patch.yml         # 向 profile 插入 id=qqbot 的插件行
├── index.js                 # 导出 host/index.js 的 apply()
├── icon.svg / locale/       # 插件市场/设置页展示元数据
├── host/
│   ├── index.js             # cordis 入口：apply(ctx)
│   ├── app.js               # 组合根：装配 config + 各服务 + admin + gateway
│   ├── config.js            # 默认配置、校验、加载/保存、脱敏
│   ├── paths.js             # 全部数据路径（默认 package/data、package/import）
│   ├── util/                # fsx / text / log 等无状态工具
│   ├── qq/                  # QQ 官方 API 客户端、WebSocket 网关、收发
│   ├── brain/               # LLM 调用、Prompt 组装、聊天主流程、命令
│   ├── memory/              # 会话历史、长期记忆、上下文压缩
│   ├── budget/              # 预算用量记录与限额检查
│   ├── persona/             # 全局 / 会话 / 用户个性化配置
│   ├── stickers/            # 表情包索引、导入、打标、挑选
│   └── admin/               # 管理后台（HTTP API + 静态页面）
├── tools/                   # 命令行工具（批量导入、旧数据迁移、静态检查）
├── data/                    # 运行时数据（config.json、记忆、表情包、预算、日志）
└── import/                  # 批量表情包导入投放目录
```

## 2. 运行时数据布局

```
qqbot/data/
├── config.json              # 全部配置（含 AppSecret，勿提交/外传）
├── budget/usage.json        # 当日/当月/按会话聚合用量
├── budget/events.jsonl      # 每次 LLM 调用明细（追加写）
├── chats/<chatId>/history.jsonl  # 会话消息（追加写；压缩后重写）
├── chats/<chatId>/summary.json   # 上下文压缩摘要
├── chats/<chatId>/memory.json    # 该会话的长期事实
├── chats/<chatId>/state.json     # 该会话的计数/状态（如上次记忆抽取）
├── people/<openid>.json     # 用户画像：昵称、事实、最后出现时间
├── personas.json            # 会话级个性化覆盖
├── stickers/index.json      # 表情包索引（id/hash/tags/desc/layer/使用次数）
├── stickers/<layer>/<id>.<ext>   # 表情包文件：library/candidate/negative/trash
└── logs/qqbot.log           # 滚动日志（管理页可看最近 N 条）
```

`chatId` 规则：单聊 `c2c_<user_openid>`，群聊 `group_<group_openid>`。

## 3. 消息主流程

```
QQ 网关(WebSocket) → gateway.js 解析 op/t
    → inbound.js 归一化事件（C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE）
    → app.js 入队（同一 chat 串行，避免上下文竞态）
    → brain/chat.js
        1. 命令识别（帮助/预算/表情/清空上下文…）
        2. 入站图片 → stickers 候选库（可关闭）
        3. budget.check() → 超限则发提示并结束
        4. 记忆召回 + 压缩判断（memory/compress.js）
        5. prompt 组装（人设 + 个性化 + 事实 + 近况 + 表情包标签目录）
        6. ctx.llm.stream() → 文本 + usage
        7. budget.record() / memory.append() / 事实抽取（异步）
        8. 解析 [[sticker: 标签]] → 表情包库挑选 → 发文字 + 发图片
    → qq/outbound.js → api.js（被动回复 msg_id+msg_seq；超时转主动消息）
```

## 4. 各子系统职责

| 子系统 | 职责 | 关键文件 |
|---|---|---|
| config | 默认值、类型校验、原子读写、密钥脱敏 | `host/config.js` |
| QQ 接入 | access_token 刷新、`/gateway`、WebSocket 鉴权/心跳/重连、收发文本与富媒体 | `host/qq/*` |
| 预算 | 每次调用记录 token/金额；日/月/会话三级限额；超限冷却 | `host/budget/store.js` |
| 记忆 | 会话历史 JSONL、长期事实、用户画像、按 token 阈值压缩摘要 | `host/memory/*` |
| 个性化 | 全局人设 + 会话级覆盖（人设/风格/模型/表情频率/记忆开关） | `host/persona/store.js` |
| 表情包 | 批量扫描导入、SHA-256 去重、图层（候选/正式/负面/回收）、标签与描述、按标签挑选、管理页打标 | `host/stickers/*` |
| 管理后台 | 同源 HTTP API + 静态页面：状态、配置、表情包、预算、会话、日志 | `host/admin/*` |

## 5. 关键设计约束

- **零运行时依赖**：只用 Node 内置模块；WebSocket 用 Node 24 全局 `WebSocket`，HTTP 用 `fetch`。
- **数据只落在 qqbot 内**：默认 `<package>/data`；可用 `QQBOT_DATA_DIR` / `QQBOT_IMPORT_DIR` 覆盖（测试用）。
- **不写 profile 文件**：只由 `plugin_manager install_bundle` 安装；插件自身配置写在 `data/config.json`。
- **不改会话日志**：本插件不注入 DSH session event，记忆/预算都是插件自有数据。
- **可降级**：`ctx.llm` / `webServer` 缺失时插件不崩溃，管理页或聊天能力按需禁用并在日志说明。
- **秘密不入日志、不回传前端**：`appSecret` 在 API 响应中只返回掩码，留空表示不修改。
- **进程内串行**：同一 chat 的回复串行处理；预算/索引写入用 promise 队列串行化。
