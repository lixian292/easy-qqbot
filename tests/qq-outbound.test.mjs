/** Tests for host/qq/outbound.js — fake API client, no network. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { chatTarget, createSender } from '../host/qq/outbound.js'
import { makeConfigStore, makeLogger, makeTempPaths } from './helpers.mjs'

function makeApi(overrides = {}) {
  const calls = { sendText: [], sendImage: [], uploadMedia: [], request: [] }
  return {
    calls,
    async sendText(args) {
      calls.sendText.push(args)
      if (typeof overrides.sendText === 'function') return overrides.sendText(args, calls)
      return { id: `msg-${calls.sendText.length}` }
    },
    async sendImage(args) {
      calls.sendImage.push(args)
      if (typeof overrides.sendImage === 'function') return overrides.sendImage(args, calls)
      return { id: `img-${calls.sendImage.length}` }
    },
    async uploadMedia(args) {
      calls.uploadMedia.push(args)
      if (typeof overrides.uploadMedia === 'function') return overrides.uploadMedia(args, calls)
      return { fileInfo: 'file-info-1', ttl: 3600 }
    },
    async request(args) {
      calls.request.push(args)
      if (typeof overrides.request === 'function') return overrides.request(args, calls)
      return { id: 'typing-1' }
    }
  }
}

function makeSender(overrides = {}) {
  const api = makeApi(overrides.api)
  const configStore = overrides.configStore ?? makeConfigStore()
  const logger = overrides.logger ?? makeLogger()
  return { sender: createSender({ api, configStore, logger }), api, configStore, logger }
}

const c2c = { kind: 'c2c', targetId: 'u-1' }
const group = { kind: 'group', targetId: 'g-1' }

test('sendText：窗口内被动回复并使用递增 msg_seq', async () => {
  const { sender, api } = makeSender()
  const receivedAt = Date.now()

  const first = await sender.sendText(c2c, '你好', { replyTo: { msgId: 'm-1', receivedAt } })
  assert.deepEqual(first, { ids: ['msg-1'], passive: true })
  assert.deepEqual(api.calls.sendText[0], { kind: 'c2c', targetId: 'u-1', content: '你好', msgId: 'm-1', msgSeq: 1 })

  const second = await sender.sendText(c2c, '再来一句', { replyTo: { msgId: 'm-1', receivedAt } })
  assert.equal(second.passive, true)
  assert.equal(api.calls.sendText[1].msgSeq, 2, '同一 msg_id 的 msg_seq 应递增')
})

test('sendText：超长文本按 textChunkSize 分片，超过次数上限后转主动消息', async () => {
  const { sender, api } = makeSender({ configStore: makeConfigStore({ qq: { textChunkSize: 100, reply: { c2cMaxReplies: 2 } } }) })
  const longText = 'x'.repeat(260)
  const result = await sender.sendText(c2c, longText, { replyTo: { msgId: 'm-2', receivedAt: Date.now() } })

  assert.equal(api.calls.sendText.length, 3, '260 字符应按 100 分 3 片')
  assert.deepEqual(result.ids, ['msg-1', 'msg-2', 'msg-3'])
  assert.equal(result.passive, true, '前两片仍是被动回复')
  assert.deepEqual(api.calls.sendText.slice(0, 2).map((call) => call.msgSeq), [1, 2])
  assert.equal('msgId' in api.calls.sendText[2], false, '超过次数上限后应为主动消息')
  assert.equal(api.calls.sendText[2].content.length, 60)
})

test('sendText：被动回复窗口过期后改发主动消息（群聊）', async () => {
  const { sender, api } = makeSender({ configStore: makeConfigStore({ qq: { reply: { groupMaxReplies: 1 } } }) })
  const expired = Date.now() - 300000 - 1000
  const result = await sender.sendText(group, '超时回复', { replyTo: { msgId: 'gm-0', receivedAt: expired } })

  assert.equal(result.passive, false)
  assert.equal('msgId' in api.calls.sendText[0], false)

  const fresh = { msgId: 'gm-1', receivedAt: Date.now() }
  const first = await sender.sendText(group, '第一句', { replyTo: fresh })
  assert.equal(first.passive, true)
  const second = await sender.sendText(group, '第二句', { replyTo: fresh })
  assert.equal(second.passive, false, '群聊被动回复达到次数上限')
  assert.equal('msgId' in api.calls.sendText[2], false)
})

test('sendText：清洗 Markdown，空文本不发送', async () => {
  const { sender, api } = makeSender()
  const result = await sender.sendText(c2c, '**加粗** 与 `代码`')
  assert.equal(api.calls.sendText[0].content, '加粗 与 代码')
  assert.deepEqual(result.ids, ['msg-1'])

  const empty = await sender.sendText(c2c, '   \n  ')
  assert.deepEqual(empty, { ids: [], passive: false })
  assert.equal(api.calls.sendText.length, 1, '空文本不应调用接口')
})

test('sendText：被动回复失败自动降级为主动消息；全部失败时抛错', async () => {
  const fallback = makeSender({
    api: {
      sendText(args) {
        if (args.msgId !== undefined) throw new Error('passive window closed')
        return { id: 'active-1' }
      }
    }
  })
  const result = await fallback.sender.sendText(c2c, 'hi', { replyTo: { msgId: 'm-err', receivedAt: Date.now() } })
  assert.equal(fallback.api.calls.sendText.length, 2)
  assert.equal(fallback.api.calls.sendText[0].msgId, 'm-err')
  assert.equal('msgId' in fallback.api.calls.sendText[1], false)
  assert.deepEqual(result, { ids: ['active-1'], passive: false })

  const failing = makeSender({ api: { sendText() { throw new Error('network down') } } })
  await assert.rejects(failing.sender.sendText(c2c, 'hi'), /network down/)
  assert.equal(failing.sender.stats().failed, 1)
})

test('sendImage：上传后发 msg_type 7，同一内容复用 file_info 缓存', async () => {
  const { sender, api } = makeSender()
  const buffer = Buffer.from('image-bytes')

  const first = await sender.sendImage(group, { buffer, fileName: 'a.png' })
  assert.deepEqual(first, { id: 'img-1' })
  assert.equal(api.calls.uploadMedia.length, 1)
  assert.equal(api.calls.uploadMedia[0].kind, 'group')
  assert.equal(api.calls.uploadMedia[0].fileType, 1)
  assert.equal(api.calls.uploadMedia[0].fileName, 'a.png')
  assert.equal(api.calls.sendImage[0].fileInfo, 'file-info-1')

  const second = await sender.sendImage(group, { buffer, fileName: 'a.png' })
  assert.deepEqual(second, { id: 'img-2' })
  assert.equal(api.calls.uploadMedia.length, 1, '相同内容不应重复上传')

  await sender.sendImage(group, { buffer, fileName: 'a.png' }, { replyTo: { msgId: 'm-9', receivedAt: Date.now() } })
  assert.equal(api.calls.sendImage[2].msgId, 'm-9')
  assert.equal(api.calls.sendImage[2].msgSeq, 1)
})

test('sendImage / sendSticker 支持 filePath，并处理读取失败', async (t) => {
  const { paths, cleanup } = await makeTempPaths()
  t.after(cleanup)
  const { sender, api } = makeSender()
  const file = path.join(paths.data, 'pic.png')
  await fsp.writeFile(file, Buffer.from('png-bytes'))

  const result = await sender.sendImage(c2c, { filePath: file })
  assert.deepEqual(result, { id: 'img-1' })
  assert.equal(api.calls.uploadMedia[0].fileName, 'pic.png')
  assert.equal(api.calls.uploadMedia[0].buffer.toString(), 'png-bytes')

  const stickerResult = await sender.sendSticker(group, { filePath: file, id: 'abc123' })
  assert.deepEqual(stickerResult, { id: 'img-2' })
  assert.equal(api.calls.uploadMedia[1].fileName, 'sticker-abc123.png')

  await assert.rejects(sender.sendImage(c2c, {}), /图片内容为空/)
  await assert.rejects(sender.sendImage(c2c, { filePath: path.join(paths.data, 'missing.png') }), /读取图片失败/)
  await assert.rejects(sender.sendSticker(c2c, {}), /缺少表情包文件路径/)
  await assert.rejects(sender.sendSticker(c2c, null), /缺少表情包信息/)
})

test('sendTyping：单聊发送 msg_type 6，群聊跳过，失败静默', async () => {
  const { sender, api } = makeSender()
  const result = await sender.sendTyping(c2c)
  assert.equal(result.ok, true)
  assert.equal(api.calls.request[0].body.msg_type, 6)
  assert.ok(api.calls.request[0].path.includes('/v2/users/u-1/messages'))

  const skipped = await sender.sendTyping(group)
  assert.deepEqual(skipped, { ok: false, skipped: true })
  assert.equal(api.calls.request.length, 1)

  const failing = makeSender({ api: { request() { throw new Error('nope') } } })
  const failed = await failing.sender.sendTyping(c2c)
  assert.equal(failed.ok, false)
})

test('chatTarget：合法 ChatRef 归一化，非法输入抛中文错误', () => {
  assert.deepEqual(chatTarget({ kind: 'group', targetId: 'g-1' }), { kind: 'group', targetId: 'g-1' })
  assert.deepEqual(chatTarget({ chatId: 'c2c_u-1', targetId: 'u-1' }), { kind: 'c2c', targetId: 'u-1' })
  assert.deepEqual(chatTarget({ kind: 'c2c', targetId: '  u-1  ' }), { kind: 'c2c', targetId: 'u-1' })

  assert.throws(() => chatTarget(null), /无效的会话对象/)
  assert.throws(() => chatTarget({ kind: 'group' }), /缺少发送目标/)
  assert.throws(() => chatTarget({ kind: 'room', targetId: 'x' }), /无效的会话类型/)
})

test('clearCache：重置被动计数与上传缓存', async () => {
  const { sender, api } = makeSender()
  const replyTo = { msgId: 'm-cache', receivedAt: Date.now() }

  await sender.sendText(c2c, '一', { replyTo })
  await sender.sendText(c2c, '二', { replyTo })
  assert.equal(api.calls.sendText[1].msgSeq, 2)

  sender.clearCache()
  await sender.sendText(c2c, '三', { replyTo })
  assert.equal(api.calls.sendText[2].msgSeq, 1, '清缓存后被动计数归零')

  const buffer = Buffer.from('cache-image')
  await sender.sendImage(c2c, { buffer, fileName: 'c.png' })
  await sender.sendImage(c2c, { buffer, fileName: 'c.png' })
  assert.equal(api.calls.uploadMedia.length, 1)
  sender.clearCache()
  await sender.sendImage(c2c, { buffer, fileName: 'c.png' })
  assert.equal(api.calls.uploadMedia.length, 2, '清缓存后重新上传')

  const stats = sender.stats()
  assert.equal(stats.text, 3)
  assert.equal(stats.image, 3)
})
