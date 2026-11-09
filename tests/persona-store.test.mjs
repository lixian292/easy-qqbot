import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import { makeConfigStore, makeLogger, makeTempPaths } from './helpers.mjs'
import { createPersonaStore } from '../host/persona/store.js'

async function setup(overrides = {}) {
  const { paths, cleanup } = await makeTempPaths()
  const configStore = makeConfigStore(overrides.config ?? {})
  const logger = makeLogger()
  const store = createPersonaStore({ paths, configStore, logger })
  return { paths, cleanup, configStore, logger, store }
}

test('init 空配置返回空结构，resolve 使用全局默认人设', async () => {
  const { store, cleanup } = await setup()
  try {
    const loaded = await store.init()
    assert.deepEqual(loaded, { chats: {}, users: {} })
    assert.deepEqual(await store.list(), { chats: {}, users: {} })

    const persona = await store.resolve({ chatId: 'c2c_u1', userId: 'u1', kind: 'c2c' })
    assert.equal(persona.name, '小Q')
    assert.equal(persona.replyMaxChars, 800)
    assert.equal(persona.stickerChance, 0.35)
    assert.equal(persona.memoryEnabled, true)
    assert.equal(persona.compressEnabled, true)
    assert.equal(persona.maxHistoryMessages, 40)
    assert.equal(persona.model, 'deepseek-flash')
    assert.equal(persona.temperature, 0.8)
    assert.equal(persona.extraPrompt, undefined)
  } finally {
    await cleanup()
  }
})

test('会话覆盖优先于全局，用户覆盖优先于会话', async () => {
  const { store, cleanup } = await setup()
  try {
    await store.set('c2c_u1', { name: '会话阿黄', style: '会话风格', replyMaxChars: 300 })
    const chatOnly = await store.resolve({ chatId: 'c2c_u1', userId: 'other' })
    assert.equal(chatOnly.name, '会话阿黄')
    assert.equal(chatOnly.style, '会话风格')
    assert.equal(chatOnly.replyMaxChars, 300)

    await store.setUser('u1', { name: '用户小明', stickerChance: 0.1 })
    const userLevel = await store.resolve({ chatId: 'c2c_u1', userId: 'u1' })
    assert.equal(userLevel.name, '用户小明')
    assert.equal(userLevel.style, '会话风格')
    assert.equal(userLevel.stickerChance, 0.1)
    assert.equal(userLevel.replyMaxChars, 300)
  } finally {
    await cleanup()
  }
})

test('set 支持局部更新，null / 空串表示删除字段，字段删空后覆盖消失', async () => {
  const { store, cleanup } = await setup()
  try {
    const created = await store.set('c2c_u1', { name: '阿黄', style: '简洁' })
    assert.deepEqual(created, { name: '阿黄', style: '简洁' })
    assert.deepEqual(await store.get('c2c_u1'), { name: '阿黄', style: '简洁' })

    const removedField = await store.set('c2c_u1', { style: '' })
    assert.deepEqual(removedField, { name: '阿黄' })

    const removedByNull = await store.set('c2c_u1', { name: null })
    assert.equal(removedByNull, null)
    assert.equal(await store.get('c2c_u1'), null)
  } finally {
    await cleanup()
  }
})

test('set 会忽略未知字段并校验数值范围', async () => {
  const { store, cleanup } = await setup()
  try {
    const patch = await store.set('c2c_u1', {
      name: '阿黄',
      unknownField: 'nope',
      replyMaxChars: 10,
      stickerChance: 5,
      temperature: -3,
      maxHistoryMessages: 1000,
      memoryEnabled: 'yes'
    })
    assert.equal(patch.unknownField, undefined)
    assert.equal(patch.replyMaxChars, 100)
    assert.equal(patch.stickerChance, 1)
    assert.equal(patch.temperature, 0)
    assert.equal(patch.maxHistoryMessages, 200)
    assert.equal(patch.memoryEnabled, undefined)
  } finally {
    await cleanup()
  }
})

test('remove / removeUser 删除覆盖', async () => {
  const { store, cleanup } = await setup()
  try {
    await store.set('c2c_u1', { name: '会话' })
    await store.setUser('u1', { name: '用户' })
    await store.remove('c2c_u1')
    await store.removeUser('u1')
    assert.equal(await store.get('c2c_u1'), null)
    const listed = await store.list()
    assert.deepEqual(listed, { chats: {}, users: {} })
  } finally {
    await cleanup()
  }
})

test('flush 后数据可被新实例重新载入', async () => {
  const { paths, cleanup, configStore } = await setup()
  try {
    const store = createPersonaStore({ paths, configStore })
    await store.set('c2c_u1', { name: '阿黄', compressEnabled: false })
    await store.setUser('u1', { style: '温柔' })
    await store.flush()

    const reloaded = createPersonaStore({ paths, configStore })
    await reloaded.init()
    assert.deepEqual(await reloaded.get('c2c_u1'), { name: '阿黄', compressEnabled: false })
    const listed = await reloaded.list()
    assert.deepEqual(listed.users, { u1: { style: '温柔' } })
    const persona = await reloaded.resolve({ chatId: 'c2c_u1', userId: 'u1' })
    assert.equal(persona.name, '阿黄')
    assert.equal(persona.style, '温柔')
    assert.equal(persona.compressEnabled, false)
  } finally {
    await cleanup()
  }
})

test('损坏的 personas.json 会被备份并重建', async () => {
  const { paths, cleanup, configStore, logger } = await setup()
  try {
    await fs.writeFile(paths.personas, 'not-json@@', 'utf8')
    const store = createPersonaStore({ paths, configStore, logger })
    await store.init()
    assert.deepEqual(await store.list(), { chats: {}, users: {} })
    const names = await fs.readdir(paths.data)
    assert.ok(names.some((name) => name.startsWith('personas.json.corrupt-')))
    assert.ok(logger.entries.some((entry) => entry.level === 'warn'))
  } finally {
    await cleanup()
  }
})
