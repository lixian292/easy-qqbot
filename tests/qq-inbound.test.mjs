/** Tests for host/qq/inbound.js — pure event normalization + dedupe. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventDedupe, normalizeDispatch } from '../host/qq/inbound.js'

test('C2C_MESSAGE_CREATE 归一化为 InboundMessage', () => {
  const timestamp = '2026-11-09T10:00:00+08:00'
  const message = normalizeDispatch('C2C_MESSAGE_CREATE', {
    id: 'msg-1',
    content: '  你好  ',
    timestamp,
    author: { user_openid: 'user-openid-1', username: '小明' },
    attachments: [
      { url: 'https://cdn.example/a.png', content_type: 'image/png', filename: 'a.png', width: 100, height: 80, size: 1234 },
      { url: '' },
      null
    ]
  })

  assert.equal(message.kind, 'c2c')
  assert.equal(message.chatId, 'c2c_user-openid-1')
  assert.equal(message.targetId, 'user-openid-1')
  assert.equal(message.userId, 'user-openid-1')
  assert.equal(message.userName, '小明')
  assert.equal(message.text, '你好')
  assert.equal(message.msgId, 'msg-1')
  assert.equal(message.timestamp, Date.parse(timestamp))
  assert.equal(message.rawType, 'C2C_MESSAGE_CREATE')
  assert.equal('eventId' in message, false)
  assert.deepEqual(message.attachments, [
    { url: 'https://cdn.example/a.png', contentType: 'image/png', filename: 'a.png', width: 100, height: 80, size: 1234 }
  ])
})

test('GROUP_AT_MESSAGE_CREATE 归一化：群字段、成员角色、外层 eventId', () => {
  const timestamp = '2026-11-09T11:00:00+08:00'
  const message = normalizeDispatch(
    'GROUP_AT_MESSAGE_CREATE',
    {
      id: 'msg-2',
      group_openid: 'group-openid-1',
      content: '在吗',
      timestamp,
      author: { member_openid: 'member-1', member_role: 'admin', username: '阿强' },
      attachments: []
    },
    { id: 'event-9' }
  )

  assert.equal(message.kind, 'group')
  assert.equal(message.chatId, 'group_group-openid-1')
  assert.equal(message.targetId, 'group-openid-1')
  assert.equal(message.userId, 'member-1')
  assert.equal(message.memberRole, 'admin')
  assert.equal(message.eventId, 'event-9')
  assert.equal(message.msgId, 'msg-2')
  assert.equal(message.text, '在吗')
  assert.equal(message.timestamp, Date.parse(timestamp))

  const plain = normalizeDispatch('GROUP_AT_MESSAGE_CREATE', {
    id: 'msg-3',
    group_openid: 'group-openid-1',
    content: '',
    author: { member_openid: 'member-2', member_role: 'guest' }
  })
  assert.equal(plain.memberRole, undefined, '未知角色不应写入 memberRole')
  assert.equal(plain.text, '')
  assert.deepEqual(plain.attachments, [])
  assert.equal(typeof plain.timestamp, 'number')
})

test('系统事件返回 SystemEvent，READY/未知事件返回 null', () => {
  const system = normalizeDispatch('FRIEND_ADD', { timestamp: '2026-11-09T12:00:00+08:00', openid: 'user-1' })
  assert.equal(system.kind, 'system')
  assert.equal(system.type, 'FRIEND_ADD')
  assert.equal(system.timestamp, Date.parse('2026-11-09T12:00:00+08:00'))
  assert.deepEqual(system.data, { timestamp: '2026-11-09T12:00:00+08:00', openid: 'user-1' })

  const delRobot = normalizeDispatch('GROUP_DEL_ROBOT', null)
  assert.equal(delRobot.kind, 'system')
  assert.equal(delRobot.data, null)
  assert.equal(typeof delRobot.timestamp, 'number')

  for (const type of ['READY', 'RESUMED', 'UNKNOWN_EVENT', '']) {
    assert.equal(normalizeDispatch(type, {}), null, `${type} 应返回 null`)
  }
})

test('畸形数据不抛错，缺失关键字段返回 null', () => {
  assert.equal(normalizeDispatch('C2C_MESSAGE_CREATE', null), null)
  assert.equal(normalizeDispatch('C2C_MESSAGE_CREATE', { author: {} }), null)
  assert.equal(normalizeDispatch('GROUP_AT_MESSAGE_CREATE', { group_openid: 'g-1', author: {} }), null)
  assert.equal(normalizeDispatch('GROUP_AT_MESSAGE_CREATE', { author: { member_openid: 'm-1' } }), null)
  assert.equal(normalizeDispatch(null, {}), null)
  assert.equal(normalizeDispatch('C2C_MESSAGE_CREATE', 'not-an-object'), null)

  const fallback = normalizeDispatch('C2C_MESSAGE_CREATE', {
    id: 'msg-4',
    content: '无时间戳',
    timestamp: 'not-a-date',
    author: { user_openid: 'user-2' }
  })
  assert.equal(fallback.kind, 'c2c')
  assert.ok(Math.abs(fallback.timestamp - Date.now()) < 5000, '非法时间戳应回退到当前时间')

  const seconds = normalizeDispatch('C2C_MESSAGE_CREATE', {
    id: 'msg-5',
    content: '秒级时间戳',
    timestamp: 1700000000,
    author: { user_openid: 'user-3' }
  })
  assert.equal(seconds.timestamp, 1700000000000)
})

test('createEventDedupe：首次 false、重复 true、LRU 淘汰、空 key 忽略', () => {
  const dedupe = createEventDedupe({ maxSize: 2 })
  assert.equal(dedupe.seen('a'), false)
  assert.equal(dedupe.seen('b'), false)
  assert.equal(dedupe.seen('a'), true, '重复 key 返回 true')
  assert.equal(dedupe.seen('c'), false, '新 key 首次 false')
  assert.equal(dedupe.seen('a'), true, '刚刷新的 key 仍在')
  assert.equal(dedupe.seen('b'), false, '最久未使用的 key 已被淘汰')
  assert.equal(dedupe.seen(''), false, '空 key 不参与去重')

  const defaults = createEventDedupe()
  assert.equal(defaults.seen('x'), false)
  assert.equal(defaults.seen('x'), true)
})

test('语音附件归一化：voice_wav_url / asr_refer_text 与既有字段并存', () => {
  const message = normalizeDispatch('C2C_MESSAGE_CREATE', {
    id: 'msg-voice-1',
    content: '[语音]',
    timestamp: '2026-11-10T09:00:00+08:00',
    author: { user_openid: 'user-voice' },
    attachments: [
      {
        content_type: 'voice',
        url: 'https://cdn.example/voice.silk',
        filename: 'voice.silk',
        size: 2048,
        voice_wav_url: 'https://cdn.example/voice.wav',
        asr_refer_text: '  今天天气不错  '
      }
    ]
  })

  assert.equal(message.text, '[语音]')
  assert.equal(message.attachments.length, 1)
  assert.deepEqual(message.attachments[0], {
    url: 'https://cdn.example/voice.silk',
    contentType: 'voice',
    filename: 'voice.silk',
    size: 2048,
    voiceWavUrl: 'https://cdn.example/voice.wav',
    asrReferText: '今天天气不错'
  })
})

test('语音附件仅有 voice_wav_url 时保留（url 缺失不抛错）', () => {
  const message = normalizeDispatch('GROUP_AT_MESSAGE_CREATE', {
    id: 'msg-voice-2',
    group_openid: 'group-1',
    content: '',
    timestamp: '2026-11-10T09:01:00+08:00',
    author: { member_openid: 'member-1', member_role: 'member' },
    attachments: [{ content_type: 'voice', voice_wav_url: 'https://cdn.example/only.wav' }]
  })

  assert.deepEqual(message.attachments, [
    { url: '', contentType: 'voice', voiceWavUrl: 'https://cdn.example/only.wav' }
  ])
  assert.equal('asrReferText' in message.attachments[0], false, '无 ASR 文本时不写字段')
})

test('视频附件归一化：video/mp4 保留尺寸/大小等字段', () => {
  const message = normalizeDispatch('GROUP_AT_MESSAGE_CREATE', {
    id: 'msg-video-1',
    group_openid: 'group-1',
    content: '看视频',
    timestamp: '2026-11-10T09:02:00+08:00',
    author: { member_openid: 'member-2', member_role: 'admin' },
    attachments: [
      { content_type: 'video/mp4', url: 'https://cdn.example/clip.mp4', filename: 'clip.mp4', width: 1280, height: 720, size: 1048576 },
      { content_type: 'file', url: 'https://cdn.example/doc.zip', filename: 'doc.zip', size: 512 }
    ]
  })

  assert.equal(message.text, '看视频')
  assert.deepEqual(message.attachments, [
    {
      url: 'https://cdn.example/clip.mp4',
      contentType: 'video/mp4',
      filename: 'clip.mp4',
      width: 1280,
      height: 720,
      size: 1048576
    },
    { url: 'https://cdn.example/doc.zip', contentType: 'file', filename: 'doc.zip', size: 512 }
  ])
  assert.equal('voiceWavUrl' in message.attachments[0], false)
  assert.equal('asrReferText' in message.attachments[0], false)
})

test('附件缺字段/类型异常不抛错', () => {
  const message = normalizeDispatch('C2C_MESSAGE_CREATE', {
    id: 'msg-attr-1',
    content: '',
    timestamp: '2026-11-10T09:03:00+08:00',
    author: { user_openid: 'user-attr' },
    attachments: [
      { content_type: 'voice' },
      { url: 'https://cdn.example/a.png' },
      {
        url: 'https://cdn.example/b.mp4',
        width: 'not-a-number',
        height: -5,
        size: 0,
        filename: 42,
        voice_wav_url: 5,
        asr_refer_text: {}
      },
      'oops',
      null,
      { url: 'https://cdn.example/voice3.silk', content_type: 'voice', voice_wav_url: '', asr_refer_text: '' }
    ]
  })

  assert.deepEqual(message.attachments, [
    { url: 'https://cdn.example/a.png' },
    { url: 'https://cdn.example/b.mp4' },
    { url: 'https://cdn.example/voice3.silk', contentType: 'voice' }
  ])

  const noAttachments = normalizeDispatch('C2C_MESSAGE_CREATE', {
    id: 'msg-attr-2',
    content: 'hi',
    author: { user_openid: 'user-attr' }
  })
  assert.deepEqual(noAttachments.attachments, [])

  const badAttachments = normalizeDispatch('C2C_MESSAGE_CREATE', {
    id: 'msg-attr-3',
    content: 'hi',
    author: { user_openid: 'user-attr' },
    attachments: 'not-an-array'
  })
  assert.deepEqual(badAttachments.attachments, [])
})
