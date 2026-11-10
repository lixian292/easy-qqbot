import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { makeConfigStore, makeFakeLlm, makeLogger, makeTempPaths, waitFor } from './helpers.mjs'
import { createChatEngine } from '../host/brain/chat.js'
import { createMemoryStore } from '../host/memory/store.js'
import { createBudgetStore } from '../host/budget/store.js'
import { createPersonaStore } from '../host/persona/store.js'
import { LlmCallError } from '../host/brain/llm.js'

function makeQQClient() {
  const sent = []
  return {
    sent,
    async sendText(chat, text, options) {
      sent.push({ type: 'text', chat, text, options })
      return { ids: ['1'], passive: true }
    },
    async sendSticker(chat, sticker, options) {
      sent.push({ type: 'sticker', chat, sticker, options })
      return { id: 's1' }
    },
    async sendImage(chat, media, options) {
      sent.push({ type: 'image', chat, media, options })
      return { id: 'i1' }
    }
  }
}

async function setup(overrides = {}) {
  const { paths, cleanup } = await makeTempPaths()
  const configStore = makeConfigStore(overrides.config ?? {})
  const logger = makeLogger()
  const memoryStore = createMemoryStore({ paths, configStore, logger })
  await memoryStore.init()
  const personaStore = createPersonaStore({ paths, configStore, logger })
  await personaStore.init()
  const budgetStore = overrides.budgetStore ?? createBudgetStore({ paths, configStore, logger })
  const llm = overrides.llm ?? makeFakeLlm({ reply: '你好呀' })
  const qqClient = overrides.qqClient ?? makeQQClient()
  const compressor = overrides.compressor ?? {
    calls: [],
    async maybeCompress(chatId) {
      this.calls.push(chatId)
      return { compressed: false, removed: 0 }
    }
  }
  const extractor = overrides.extractor ?? {
    calls: [],
    async maybeExtract(args) {
      this.calls.push(args)
      return { extracted: false, facts: [] }
    }
  }
  const stickerSelector = overrides.stickerSelector ?? {
    async catalogText() {
      return ''
    },
    async maybeStickerFromText() {
      return null
    },
    async pickForReply() {
      return null
    }
  }
  const commandHandler = overrides.commandHandler ?? {
    calls: [],
    async tryHandle(inbound) {
      this.calls.push(inbound)
      return { handled: false }
    }
  }
  const engine = createChatEngine({
    configStore,
    personaStore,
    memoryStore,
    budgetStore,
    llmClient: llm,
    compressor,
    extractor,
    stickerStore: overrides.stickerStore,
    stickerSelector,
    commandHandler,
    qqClient,
    logger,
    captureIncomingImage: overrides.captureIncomingImage,
    describeIncomingMedia: overrides.describeIncomingMedia
  })
  return {
    paths,
    cleanup,
    configStore,
    logger,
    memoryStore,
    personaStore,
    budgetStore,
    llm,
    qqClient,
    compressor,
    extractor,
    stickerSelector,
    commandHandler,
    engine
  }
}

function makeInbound(overrides = {}) {
  return {
    kind: 'c2c',
    chatId: 'c2c_u1',
    targetId: 'u1',
    userId: 'u1',
    userName: '小明',
    text: '在吗',
    msgId: 'm1',
    timestamp: Date.now(),
    attachments: [],
    rawType: 'C2C_MESSAGE_CREATE',
    ...overrides
  }
}

test('正常流程：回复文本、记录预算、写会话历史并异步抽取记忆', async () => {
  const { engine, llm, qqClient, memoryStore, budgetStore, extractor, cleanup } = await setup()
  try {
    const inbound = makeInbound()
    await engine.handleInbound(inbound)

    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].purpose, 'chat')
    assert.ok(llm.calls[0].system.includes('小Q'))
    assert.deepEqual(llm.calls[0].messages[llm.calls[0].messages.length - 1], { role: 'user', content: '在吗' })

    assert.equal(qqClient.sent.length, 1)
    assert.equal(qqClient.sent[0].type, 'text')
    assert.equal(qqClient.sent[0].text, '你好呀')
    assert.deepEqual(qqClient.sent[0].chat, { kind: 'c2c', targetId: 'u1', chatId: 'c2c_u1' })
    assert.equal(qqClient.sent[0].options.replyTo.msgId, 'm1')

    const chat = await memoryStore.getChat('c2c_u1')
    assert.equal(chat.history.length, 2)
    assert.equal(chat.history[0].role, 'user')
    assert.equal(chat.history[1].role, 'assistant')
    assert.equal(chat.history[1].content, '你好呀')

    const snapshot = await budgetStore.snapshot()
    assert.equal(snapshot.today.calls, 1)

    await waitFor(() => extractor.calls.length === 1)
    assert.deepEqual(extractor.calls[0], {
      chatId: 'c2c_u1',
      speaker: { userId: 'u1', name: '小明', isGroup: false }
    })
  } finally {
    await cleanup()
  }
})

test('命令被本地处理时不调用 LLM，也不写会话历史', async () => {
  const { engine, llm, qqClient, memoryStore, commandHandler, cleanup } = await setup({
    commandHandler: {
      calls: [],
      async tryHandle(inbound) {
        this.calls.push(inbound)
        return { handled: true, text: '帮助内容' }
      }
    }
  })
  try {
    await engine.handleInbound(makeInbound({ text: '#帮助' }))
    assert.equal(commandHandler.calls.length, 1)
    assert.equal(llm.calls.length, 0)
    assert.equal(qqClient.sent.length, 1)
    assert.equal(qqClient.sent[0].text, '帮助内容')
    assert.equal((await memoryStore.getChat('c2c_u1')).history.length, 0)
  } finally {
    await cleanup()
  }
})

test('预算超限时发提示且不调用 LLM，冷却期内不重复提示', async () => {
  const budgetStore = {
    checks: 0,
    records: 0,
    async check() {
      this.checks += 1
      return { allowed: false, reason: 'daily', usage: {}, limits: {} }
    },
    async record() {
      this.records += 1
    }
  }
  const { engine, llm, qqClient, memoryStore, cleanup } = await setup({ budgetStore })
  try {
    const blockMessage = '今天的聊天额度已经用完啦，明天再来找我吧～'
    await engine.handleInbound(makeInbound())
    assert.equal(llm.calls.length, 0)
    assert.equal(qqClient.sent.length, 1)
    assert.equal(qqClient.sent[0].text, blockMessage)
    assert.equal(budgetStore.records, 0)

    let chat = await memoryStore.getChat('c2c_u1')
    assert.equal(chat.history.length, 2)
    assert.equal(chat.history[0].role, 'user')
    assert.equal(chat.history[1].role, 'assistant')
    assert.equal(chat.history[1].content, blockMessage)

    await engine.handleInbound(makeInbound({ msgId: 'm2', text: '还在吗' }))
    assert.equal(qqClient.sent.length, 1) // cooldown suppresses the second notice
    chat = await memoryStore.getChat('c2c_u1')
    assert.equal(chat.history.length, 3) // the blocked user message is still stored
    assert.equal(chat.history[2].role, 'user')
  } finally {
    await cleanup()
  }
})

test('LLM 失败时发兜底文案且 handleInbound 不抛错', async () => {
  const { engine, qqClient, memoryStore, cleanup } = await setup({
    llm: makeFakeLlm({ error: new LlmCallError('模型炸了', { code: 'AUTH' }) })
  })
  try {
    await assert.doesNotReject(engine.handleInbound(makeInbound()))
    assert.equal(qqClient.sent.length, 1)
    assert.equal(qqClient.sent[0].text, '我这边刚刚走神了，再说一次？')
    const chat = await memoryStore.getChat('c2c_u1')
    assert.equal(chat.history.length, 2)
    assert.equal(chat.history[1].content, '我这边刚刚走神了，再说一次？')
  } finally {
    await cleanup()
  }
})

test('显式表情指令：先发文字再发匹配的表情包（传 {filePath,id} 给 sender）', async () => {
  const sticker = { id: 's1', tags: ['开心'] }
  const used = []
  const { engine, qqClient, paths, cleanup } = await setup({
    llm: makeFakeLlm({ reply: '不错不错 [[sticker: 开心]]' }),
    stickerSelector: {
      async catalogText() {
        return '开心(3)、无语(2)'
      },
      async maybeStickerFromText() {
        return null
      },
      async pickForReply(tags) {
        assert.deepEqual(tags, ['开心'])
        return sticker
      }
    },
    stickerStore: {
      filePath(item) {
        assert.equal(item.id, 's1')
        return path.join(paths.stickerLibrary, 's1.png')
      },
      recordUse(id) {
        used.push(id)
        return Promise.resolve()
      }
    }
  })
  try {
    const realFile = path.join(paths.stickerLibrary, 's1.png')
    await fs.writeFile(realFile, 'png-bytes')
    await engine.handleInbound(makeInbound())
    assert.equal(qqClient.sent.length, 2)
    assert.equal(qqClient.sent[0].type, 'text')
    assert.equal(qqClient.sent[0].text, '不错不错')
    assert.equal(qqClient.sent[1].type, 'sticker')
    assert.deepEqual(qqClient.sent[1].sticker, { filePath: realFile, id: 's1' })
    await fs.access(realFile)
    await waitFor(() => used.length === 1)
    assert.deepEqual(used, ['s1'])
  } finally {
    await cleanup()
  }
})

test('没有显式指令时按 stickerChance 自动配表情', async () => {
  const sticker = { id: 'auto', tags: ['开心'] }
  const { engine, qqClient, personaStore, paths, cleanup } = await setup({
    llm: makeFakeLlm({ reply: '好耶' }),
    stickerSelector: {
      async catalogText() {
        return '开心(3)'
      },
      async maybeStickerFromText(text) {
        assert.equal(text, '好耶')
        return sticker
      },
      async pickForReply() {
        return null
      }
    },
    stickerStore: {
      filePath(item) {
        return path.join(paths.stickerLibrary, `${item.id}.gif`)
      }
    }
  })
  try {
    const realFile = path.join(paths.stickerLibrary, 'auto.gif')
    await fs.writeFile(realFile, 'gif-bytes')
    // per-chat persona override: guaranteed sticker, deterministic test
    await personaStore.set('c2c_u1', { stickerChance: 1 })
    await engine.handleInbound(makeInbound())
    assert.equal(qqClient.sent.length, 2)
    assert.equal(qqClient.sent[1].type, 'sticker')
    assert.deepEqual(qqClient.sent[1].sticker, { filePath: realFile, id: 'auto' })
  } finally {
    await cleanup()
  }
})

test('会话级 stickerChance=0 时不自动配表情', async () => {
  const { engine, qqClient, personaStore, cleanup } = await setup({
    llm: makeFakeLlm({ reply: '好耶' }),
    stickerSelector: {
      async catalogText() {
        return '开心(3)'
      },
      async maybeStickerFromText() {
        return { id: 'should-not-be-used', tags: ['开心'] }
      },
      async pickForReply() {
        return null
      }
    }
  })
  try {
    await personaStore.set('c2c_u1', { stickerChance: 0 })
    await engine.handleInbound(makeInbound())
    assert.equal(qqClient.sent.length, 1)
    assert.equal(qqClient.sent[0].type, 'text')
  } finally {
    await cleanup()
  }
})

test('入站图片：触发 captureIncomingImage 并在用户消息中标记图片信息', async () => {
  const captured = []
  const { engine, llm, memoryStore, cleanup } = await setup({
    captureIncomingImage: async (attachment, inbound) => {
      captured.push({ attachment, chatId: inbound.chatId })
      return { item: { id: 'cand1' } }
    }
  })
  try {
    await engine.handleInbound(
      makeInbound({
        text: '',
        attachments: [{ url: 'https://example.com/cat.png', contentType: 'image/png' }]
      })
    )
    await waitFor(() => captured.length === 1)
    assert.equal(captured[0].attachment.url, 'https://example.com/cat.png')
    assert.equal(captured[0].chatId, 'c2c_u1')

    const lastUser = llm.calls[0].messages[llm.calls[0].messages.length - 1]
    assert.equal(lastUser.role, 'user')
    assert.equal(lastUser.content, '[图片 image/png]')
    const chat = await memoryStore.getChat('c2c_u1')
    assert.equal(chat.history[0].content, '[图片 image/png]')
  } finally {
    await cleanup()
  }
})

test('入站图片：describeIncomingMedia 的描述注入用户消息', async () => {
  const seen = []
  const { engine, llm, memoryStore, cleanup } = await setup({
    describeIncomingMedia: async (attachment, inbound) => {
      seen.push({ attachment, chatId: inbound.chatId })
      return '一只橘猫趴在键盘上，配文“摸鱼中”'
    }
  })
  try {
    await engine.handleInbound(
      makeInbound({
        text: '看看这个',
        attachments: [{ url: 'https://example.com/cat.jpg', contentType: 'image/jpeg', width: 640, height: 480 }]
      })
    )
    assert.equal(seen.length, 1)
    assert.equal(seen[0].attachment.url, 'https://example.com/cat.jpg')
    const lastUser = llm.calls[0].messages[llm.calls[0].messages.length - 1]
    assert.equal(lastUser.role, 'user')
    assert.match(lastUser.content, /看看这个/)
    assert.match(lastUser.content, /\[图片 640×480 image\/jpeg\]（图片内容：一只橘猫趴在键盘上/)
    assert.equal(lastUser.content.includes('[图片]'), false)

    const chat = await memoryStore.getChat('c2c_u1')
    assert.match(chat.history[0].content, /图片内容：一只橘猫/)
  } finally {
    await cleanup()
  }
})

test('入站语音 / 视频：分别用语音、视频标记注入识别文本', async () => {
  const descriptions = []
  const { engine, llm, memoryStore, cleanup } = await setup({
    describeIncomingMedia: async (attachment) => {
      descriptions.push(attachment.contentType)
      if (attachment.contentType === 'voice') return '对方说晚上一起吃饭'
      return '一只猫在跳舞'
    }
  })
  try {
    await engine.handleInbound(
      makeInbound({
        text: '',
        attachments: [
          { url: 'https://example.com/voice.silk', voiceWavUrl: 'https://example.com/voice.wav', contentType: 'voice' },
          { url: 'https://example.com/cat.mp4', contentType: 'video/mp4' }
        ]
      })
    )
    assert.deepEqual(descriptions, ['voice', 'video/mp4'])
    const lastUser = llm.calls[0].messages[llm.calls[0].messages.length - 1]
    assert.match(lastUser.content, /\[语音\]（语音内容：对方说晚上一起吃饭）/)
    assert.match(lastUser.content, /\[视频 video\/mp4\]（视频内容：一只猫在跳舞）/)

    const chat = await memoryStore.getChat('c2c_u1')
    assert.match(chat.history[0].content, /语音内容：对方说晚上一起吃饭/)
  } finally {
    await cleanup()
  }
})

test('入站媒体：描述失败或无描述器时降级为占位标记', async () => {
  const failing = await setup({
    describeIncomingMedia: async () => {
      throw new Error('multimodal unavailable')
    }
  })
  try {
    await failing.engine.handleInbound(
      makeInbound({
        text: '',
        attachments: [
          { url: 'https://example.com/cat.png', contentType: 'image/png' },
          { url: 'https://example.com/v.mp4', contentType: 'video/mp4' }
        ]
      })
    )
    const lastUser = failing.llm.calls[0].messages[failing.llm.calls[0].messages.length - 1]
    assert.equal(lastUser.content, '[图片 image/png] [视频 video/mp4]')
    assert.ok(failing.logger.entries.some((entry) => entry.level === 'warn'))
  } finally {
    await failing.cleanup()
  }

  const noDescriber = await setup()
  try {
    await noDescriber.engine.handleInbound(
      makeInbound({ text: '', attachments: [{ url: 'https://example.com/a.png', contentType: 'image/png' }] })
    )
    const lastUser = noDescriber.llm.calls[0].messages[noDescriber.llm.calls[0].messages.length - 1]
    assert.equal(lastUser.content, '[图片 image/png]')
  } finally {
    await noDescriber.cleanup()
  }
})

test('同一会话的消息串行处理', async () => {
  const order = []
  const llm = {
    async complete(args) {
      const content = args.messages[args.messages.length - 1].content
      order.push(content)
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { text: `回复：${content}`, usage: { inputTokens: 1, outputTokens: 1 }, provider: 'p', model: 'm', finishKind: 'stop' }
    }
  }
  const { engine, qqClient, cleanup } = await setup({ llm })
  try {
    const first = engine.handleInbound(makeInbound({ text: '第一条', msgId: 'm1' }))
    const second = engine.handleInbound(makeInbound({ text: '第二条', msgId: 'm2' }))
    await Promise.all([first, second])
    assert.deepEqual(order, ['第一条', '第二条'])
    assert.deepEqual(
      qqClient.sent.map((item) => item.text),
      ['回复：第一条', '回复：第二条']
    )
  } finally {
    await cleanup()
  }
})

test('命令处理抛错时继续走 LLM；发送失败也不抛出', async () => {
  const throwingCommandHandler = {
    async tryHandle() {
      throw new Error('command boom')
    }
  }
  const qqClient = {
    sent: [],
    async sendText() {
      throw new Error('qq down')
    },
    async sendSticker() {
      throw new Error('qq down')
    }
  }
  const { engine, memoryStore, cleanup } = await setup({ commandHandler: throwingCommandHandler, qqClient })
  try {
    await assert.doesNotReject(engine.handleInbound(makeInbound()))
    assert.equal((await memoryStore.getChat('c2c_u1')).history.length, 2)
  } finally {
    await cleanup()
  }
})

test('会话级 model / temperature 覆盖会传给 LLM', async () => {
  const { engine, llm, personaStore, cleanup } = await setup()
  try {
    await personaStore.set('c2c_u1', { model: 'session-model', temperature: 0.3 })
    await engine.handleInbound(makeInbound())
    assert.equal(llm.calls[0].model, 'session-model')
    assert.equal(llm.calls[0].temperature, 0.3)
  } finally {
    await cleanup()
  }
})

test('compressChat / extractFacts 委托给对应模块', async () => {
  const compressor = {
    async compressNow(chatId) {
      return { compressed: true, removed: 4, summary: '摘要', chatId }
    }
  }
  const extractor = {
    async extractNow(chatId) {
      return { extracted: true, facts: ['用户喜欢猫'], chatId }
    }
  }
  const { engine, cleanup } = await setup({ compressor, extractor })
  try {
    assert.deepEqual(await engine.compressChat('c2c_u1'), { compressed: true, removed: 4, summary: '摘要', chatId: 'c2c_u1' })
    assert.deepEqual(await engine.extractFacts('c2c_u1'), { extracted: true, facts: ['用户喜欢猫'], chatId: 'c2c_u1' })
    assert.deepEqual(await engine.compressChat(''), { compressed: false, removed: 0 })
  } finally {
    await cleanup()
  }
})

test('群聊：只把当前发言者的成员事实注入 system prompt', async () => {
  const { engine, llm, memoryStore, cleanup } = await setup()
  try {
    await memoryStore.addChatMemberFacts('group_g1', 'u1', ['小明喜欢猫'], { name: '小明' })
    await memoryStore.addChatMemberFacts('group_g1', 'u2', ['小红喜欢狗'], { name: '小红' })
    await engine.handleInbound(
      makeInbound({ kind: 'group', chatId: 'group_g1', targetId: 'g1', userId: 'u1', userName: '小明', msgId: 'gm1', text: '在吗' })
    )
    const system = llm.calls[0].system
    assert.ok(system.includes('【当前群成员「小明」的长期记忆】'))
    assert.ok(system.includes('小明喜欢猫'))
    assert.equal(system.includes('小红喜欢狗'), false)
  } finally {
    await cleanup()
  }
})

test('群聊抽取传 speaker（isGroup=true）', async () => {
  const { engine, extractor, cleanup } = await setup()
  try {
    await engine.handleInbound(
      makeInbound({ kind: 'group', chatId: 'group_g1', targetId: 'g1', userId: 'u1', userName: '小明', msgId: 'gm1' })
    )
    await waitFor(() => extractor.calls.length === 1)
    assert.deepEqual(extractor.calls[0], {
      chatId: 'group_g1',
      speaker: { userId: 'u1', name: '小明', isGroup: true }
    })
  } finally {
    await cleanup()
  }
})

test('单聊不读取成员事实文件，也不注入成员记忆段', async () => {
  const { engine, llm, memoryStore, cleanup } = await setup()
  try {
    await memoryStore.addChatMemberFacts('c2c_u1', 'u1', ['小明喜欢猫'], { name: '小明' })
    let memberReads = 0
    const original = memoryStore.getChatMember.bind(memoryStore)
    memoryStore.getChatMember = async (...args) => {
      memberReads += 1
      return original(...args)
    }
    await engine.handleInbound(makeInbound())
    assert.equal(memberReads, 0)
    assert.equal(llm.calls[0].system.includes('当前群成员'), false)
    assert.equal(llm.calls[0].system.includes('小明喜欢猫'), false)
  } finally {
    await cleanup()
  }
})

test('群聊没有成员事实时 prompt 不含成员记忆段', async () => {
  const { engine, llm, cleanup } = await setup()
  try {
    await engine.handleInbound(
      makeInbound({ kind: 'group', chatId: 'group_g1', targetId: 'g1', userId: 'u9', userName: '路人', msgId: 'gm9' })
    )
    assert.equal(llm.calls[0].system.includes('当前群成员'), false)
  } finally {
    await cleanup()
  }
})
