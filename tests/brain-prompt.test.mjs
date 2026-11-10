import test from 'node:test'
import assert from 'node:assert/strict'

import { buildMessages, buildStickerInstruction, buildSystemPrompt } from '../host/brain/prompt.js'

function makeConfig(overrides = {}) {
  const base = {
    persona: {
      name: '小Q',
      systemPrompt: '你是群里的朋友。',
      style: '简短口语化',
      replyMaxChars: 800,
      stickerChance: 0.35,
      memoryEnabled: true,
      compressEnabled: true,
      maxHistoryMessages: 40
    },
    stickers: { enabled: true }
  }
  return { ...base, ...overrides }
}

test('buildSystemPrompt 包含人设、风格、时间、事实、摘要与表情包指令', () => {
  const prompt = buildSystemPrompt({
    config: makeConfig(),
    persona: { ...makeConfig().persona, extraPrompt: '不要主动提自己是 AI。' },
    facts: [{ text: '用户喜欢猫' }, '用户住在杭州'],
    summary: { text: '之前聊过期末考试' },
    stickerCatalog: '开心(3)、无语(2)',
    now: new Date('2026-01-02T03:04:05').getTime()
  })
  assert.ok(prompt.includes('小Q'))
  assert.ok(prompt.includes('你是群里的朋友。'))
  assert.ok(prompt.includes('简短口语化'))
  assert.ok(prompt.includes('当前时间：2026-01-02'))
  assert.ok(prompt.includes('用户喜欢猫'))
  assert.ok(prompt.includes('用户住在杭州'))
  assert.ok(prompt.includes('之前聊过期末考试'))
  assert.ok(prompt.includes('[[sticker: 标签1, 标签2]]'))
  assert.ok(prompt.includes('纯文本'))
  assert.ok(prompt.includes('不要主动提自己是 AI。'))
})

test('buildSystemPrompt 在表情包关闭或目录为空时不输出表情包指令', () => {
  const disabled = buildSystemPrompt({ config: makeConfig({ stickers: { enabled: false } }), stickerCatalog: '开心(3)' })
  assert.ok(!disabled.includes('[[sticker:'))
  assert.ok(!disabled.includes('表情包'))

  const noCatalog = buildSystemPrompt({ config: makeConfig(), stickerCatalog: '' })
  assert.ok(!noCatalog.includes('[[sticker:'))

  const zeroChance = buildSystemPrompt({
    config: makeConfig(),
    stickerCatalog: '开心(3)',
    persona: { ...makeConfig().persona, stickerChance: 0 }
  })
  assert.ok(!zeroChance.includes('[[sticker:'))
})

test('buildSystemPrompt 缺省值可用（空 config / 空 facts）', () => {
  const prompt = buildSystemPrompt({ config: {}, now: 0 })
  assert.ok(typeof prompt === 'string')
  assert.ok(prompt.includes('小Q'))
  assert.ok(!prompt.includes('长期记忆'))
})

test('buildStickerInstruction 只有目录非空且概率为正时才返回指令', () => {
  assert.equal(buildStickerInstruction({ stickerCatalog: '', stickerChance: 0.3 }), '')
  assert.equal(buildStickerInstruction({ stickerCatalog: '开心(1)', stickerChance: 0 }), '')
  const instruction = buildStickerInstruction({ stickerCatalog: '开心(1)', stickerChance: 0.35 })
  assert.ok(instruction.includes('开心(1)'))
  assert.ok(instruction.includes('35%'))
})

test('buildMessages 把历史转换成消息并追加最新用户消息', () => {
  const history = [
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '第一回' },
    { role: 'user', content: '第二句' }
  ]
  const messages = buildMessages({ history, userMessage: '第三句', maxMessages: 40 })
  assert.equal(messages.length, 4)
  assert.deepEqual(messages[0], { role: 'user', content: '第一句' })
  assert.deepEqual(messages[3], { role: 'user', content: '第三句' })
})

test('buildMessages 超过 maxMessages 时只保留最近的消息', () => {
  const history = []
  for (let index = 0; index < 10; index += 1) {
    history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: `消息${index}` })
  }
  const messages = buildMessages({ history, userMessage: '最新', maxMessages: 3 })
  assert.equal(messages.length, 4)
  assert.equal(messages[0].content, '消息7')
  assert.equal(messages[1].content, '消息8')
  assert.equal(messages[2].content, '消息9')
  assert.equal(messages[3].content, '最新')
})

test('buildMessages 过滤空内容与非法角色，空历史时仍可只发用户消息', () => {
  const messages = buildMessages({
    history: [
      { role: 'user', content: '' },
      { role: 'tool', content: '忽略我' },
      { role: 'assistant', content: '  ' },
      { role: 'assistant', content: '保留我' }
    ],
    userMessage: '你好'
  })
  assert.deepEqual(messages, [
    { role: 'assistant', content: '保留我' },
    { role: 'user', content: '你好' }
  ])

  assert.deepEqual(buildMessages({ history: [], userMessage: '单独一句' }), [{ role: 'user', content: '单独一句' }])
  assert.deepEqual(buildMessages({ history: [] }), [])
})

test('群聊 buildSystemPrompt 追加当前发言者的长期记忆段', () => {
  const prompt = buildSystemPrompt({
    config: makeConfig(),
    persona: makeConfig().persona,
    facts: ['群里周末经常开黑'],
    isGroupChat: true,
    speakerFacts: [{ text: '小明喜欢猫' }, '小明住在杭州'],
    speakerName: '小明'
  })
  assert.ok(prompt.includes('【当前群成员「小明」的长期记忆】'))
  assert.ok(prompt.includes('小明喜欢猫'))
  assert.ok(prompt.includes('小明住在杭州'))
  assert.ok(prompt.includes('群里周末经常开黑'))
})

test('单聊或发言者事实为空时不输出群成员记忆段', () => {
  const singleChat = buildSystemPrompt({
    config: makeConfig(),
    isGroupChat: false,
    speakerFacts: ['小明喜欢猫'],
    speakerName: '小明'
  })
  assert.ok(!singleChat.includes('当前群成员'))

  const emptyFacts = buildSystemPrompt({
    config: makeConfig(),
    isGroupChat: true,
    speakerFacts: [],
    speakerName: '小明'
  })
  assert.ok(!emptyFacts.includes('当前群成员'))

  const noName = buildSystemPrompt({
    config: makeConfig(),
    isGroupChat: true,
    speakerFacts: ['喜欢猫']
  })
  assert.ok(noName.includes('【当前群成员「当前发言者」的长期记忆】'))
})
