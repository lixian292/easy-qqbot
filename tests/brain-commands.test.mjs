import test from 'node:test'
import assert from 'node:assert/strict'

import { makeConfigStore, makeLogger } from './helpers.mjs'
import { createCommandHandler } from '../host/brain/commands.js'

const STICKER = { id: 's1', tags: ['开心'], filePath: 'C:/tmp/s1.png' }

function makeBudgetStore() {
  return {
    calls: 0,
    async snapshot() {
      this.calls += 1
      return {
        date: '2026-01-02',
        monthKey: '2026-01',
        today: { calls: 2, inputTokens: 200, outputTokens: 100, totalTokens: 300, cost: 0.5 },
        month: { calls: 5, inputTokens: 600, outputTokens: 300, totalTokens: 900, cost: 1.5 },
        chats: [{ chatId: 'c2c_u1', calls: 1, totalTokens: 100, cost: 0.1, lastAt: 1 }],
        limits: { dailyTokens: 200000, monthlyTokens: 3000000, perChatDailyTokens: 50000, dailyCalls: 1000 },
        currency: 'CNY'
      }
    }
  }
}

function makeMemoryStore() {
  return {
    cleared: [],
    async getChat() {
      return { id: 'c2c_u1', facts: [{ id: 'f1', text: '用户喜欢猫' }, { id: 'f2', text: '用户住在杭州' }] }
    },
    async clearChat(chatId, options) {
      this.cleared.push({ chatId, options })
      return { id: chatId }
    },
    async listChats() {
      return [{ chatId: 'c2c_u1' }, { chatId: 'group_1' }]
    }
  }
}

function makeStickerStore() {
  return {
    picks: [],
    async pick({ tags }) {
      this.picks.push(tags)
      return STICKER
    },
    async stats() {
      return { total: 5, byLayer: { library: 3, candidate: 1, negative: 1, trash: 0 }, tags: 4 }
    },
    async catalog() {
      return { total: 5, tags: [{ tag: '开心', count: 3 }, { tag: '无语', count: 2 }], byLayer: {} }
    }
  }
}

function makeStickerSelector(overrides = {}) {
  return {
    picks: [],
    async pickForReply(tags) {
      this.picks.push(tags)
      if (overrides.sticker === null) return null
      return overrides.sticker ?? STICKER
    }
  }
}

function setup(overrides = {}) {
  const configStore = makeConfigStore(overrides.config ?? { commands: { adminOpenids: ['admin1'] } })
  const logger = makeLogger()
  const budgetStore = overrides.budgetStore ?? makeBudgetStore()
  const memoryStore = overrides.memoryStore ?? makeMemoryStore()
  const stickerStore = overrides.stickerStore ?? makeStickerStore()
  const stickerSelector = overrides.stickerSelector ?? makeStickerSelector()
  const handler = createCommandHandler({ configStore, budgetStore, memoryStore, stickerStore, stickerSelector, logger })
  return { handler, configStore, logger, budgetStore, memoryStore, stickerStore, stickerSelector }
}

function makeInbound(overrides = {}) {
  return {
    kind: 'c2c',
    chatId: 'c2c_u1',
    targetId: 'u1',
    userId: 'u1',
    userName: '小明',
    text: '',
    msgId: 'm1',
    timestamp: Date.now(),
    attachments: [],
    rawType: 'C2C_MESSAGE_CREATE',
    ...overrides
  }
}

test('非命令 / 空文本 / 命令关闭时返回 handled:false', async () => {
  const { handler } = setup()
  assert.deepEqual(await handler.tryHandle(makeInbound({ text: '今天吃什么' })), { handled: false })
  assert.deepEqual(await handler.tryHandle(makeInbound({ text: '   ' })), { handled: false })
  assert.deepEqual(await handler.tryHandle(makeInbound({ text: '#未知命令' })), { handled: false })

  const disabled = setup({ config: { commands: { enabled: false } } })
  assert.deepEqual(await disabled.handler.tryHandle(makeInbound({ text: '#帮助' })), { handled: false })
})

test('#帮助 支持 #、/、／ 前缀', async () => {
  const { handler } = setup()
  for (const text of ['#帮助', '/帮助', '／HELP', '#help']) {
    const result = await handler.tryHandle(makeInbound({ text }))
    assert.equal(result.handled, true)
    assert.ok(result.text.includes('#预算'))
    assert.ok(result.text.includes('#清空上下文'))
  }
})

test('#预算 返回今日 / 本月 / 本会话用量', async () => {
  const { handler, budgetStore } = setup()
  const result = await handler.tryHandle(makeInbound({ text: '#预算' }))
  assert.equal(result.handled, true)
  assert.equal(budgetStore.calls, 1)
  assert.ok(result.text.includes('今日'))
  assert.ok(result.text.includes('本月'))
  assert.ok(result.text.includes('本会话'))
  assert.ok(result.text.includes('CNY'))
  assert.ok(result.text.includes('300'))
})

test('#表情 有标签时返回表情，无标签/无匹配时返回提示', async () => {
  const { handler, stickerSelector } = setup()
  const matched = await handler.tryHandle(makeInbound({ text: '#表情 开心' }))
  assert.equal(matched.handled, true)
  assert.equal(matched.sticker.id, 's1')
  assert.deepEqual(stickerSelector.picks[0], ['开心'])

  const noArgs = await handler.tryHandle(makeInbound({ text: '#表情' }))
  assert.equal(noArgs.handled, true)
  assert.ok(noArgs.text.includes('用法'))

  const noMatchSetup = setup({
    stickerSelector: makeStickerSelector({ sticker: null }),
    stickerStore: {
      async pick() {
        return null
      }
    }
  })
  const noMatch = await noMatchSetup.handler.tryHandle(makeInbound({ text: '/sticker 不存在' }))
  assert.equal(noMatch.handled, true)
  assert.ok(noMatch.text.includes('没有找到'))
})

test('#记忆 列出本会话长期事实，无记忆时提示', async () => {
  const { handler } = setup()
  const result = await handler.tryHandle(makeInbound({ text: '#记忆' }))
  assert.equal(result.handled, true)
  assert.ok(result.text.includes('用户喜欢猫'))
  assert.ok(result.text.includes('用户住在杭州'))

  const emptySetup = setup({
    memoryStore: {
      async getChat() {
        return { id: 'c2c_u1', facts: [] }
      }
    }
  })
  const empty = await emptySetup.handler.tryHandle(makeInbound({ text: '#记忆' }))
  assert.equal(empty.handled, true)
  assert.ok(empty.text.includes('还没有'))
})

test('#清空上下文 清空历史但保留事实', async () => {
  const { handler, memoryStore } = setup()
  const result = await handler.tryHandle(makeInbound({ text: '#清空上下文' }))
  assert.equal(result.handled, true)
  assert.equal(memoryStore.cleared.length, 1)
  assert.equal(memoryStore.cleared[0].chatId, 'c2c_u1')
  assert.equal(memoryStore.cleared[0].options.keepFacts, true)
  assert.ok(result.text.includes('清空'))
})

test('#状态 仅管理员可用', async () => {
  const { handler } = setup()
  const denied = await handler.tryHandle(makeInbound({ text: '#状态' }))
  assert.equal(denied.handled, true)
  assert.ok(denied.text.includes('管理员'))

  const admin = await handler.tryHandle(makeInbound({ text: '#状态', userId: 'admin1' }))
  assert.equal(admin.handled, true)
  assert.ok(admin.text.includes('运行状态'))
  assert.ok(admin.text.includes('会话数：2'))
  assert.ok(admin.text.includes('表情包：5 张'))
})

test('群主 / 管理员在 allowGroupOwner 打开时可以执行管理员命令', async () => {
  const { handler } = setup()
  const ownerStatus = await handler.tryHandle(makeInbound({ kind: 'group', chatId: 'group_1', targetId: 'g1', userId: 'u2', memberRole: 'owner', text: '#状态' }))
  assert.equal(ownerStatus.handled, true)
  assert.ok(ownerStatus.text.includes('运行状态'))

  const closed = setup({ config: { commands: { allowGroupOwner: false, adminOpenids: [] } } })
  const denied = await closed.handler.tryHandle(
    makeInbound({ kind: 'group', chatId: 'group_1', targetId: 'g1', userId: 'u2', memberRole: 'owner', text: '#状态' })
  )
  assert.ok(denied.text.includes('管理员'))
})

test('#表情包统计 管理员可见图层数量与热门标签', async () => {
  const { handler } = setup()
  const denied = await handler.tryHandle(makeInbound({ text: '#表情包统计' }))
  assert.ok(denied.text.includes('管理员'))

  const result = await handler.tryHandle(makeInbound({ text: '#表情包统计', userId: 'admin1' }))
  assert.equal(result.handled, true)
  assert.ok(result.text.includes('library：3'))
  assert.ok(result.text.includes('candidate：1'))
  assert.ok(result.text.includes('开心(3)'))
  assert.ok(result.text.includes('无语(2)'))
})

test('依赖抛错时 tryHandle 不抛异常，返回中文错误提示', async () => {
  const { handler } = setup({
    memoryStore: {
      async getChat() {
        throw new Error('disk broken')
      }
    }
  })
  const result = await handler.tryHandle(makeInbound({ text: '#记忆' }))
  assert.equal(result.handled, true)
  assert.equal(typeof result.text, 'string')
  assert.ok(result.text.includes('失败'))
})
