/** Lead-owned test: inbound normalization cleans QQ protocol markup. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDispatch } from '../host/qq/inbound.js'

test('inbound C2C content cleans QQ face markup before it reaches the model', () => {
  const message = normalizeDispatch('C2C_MESSAGE_CREATE', {
    id: 'msg-1',
    content: '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0="> [图片]',
    timestamp: '2026-11-09T22:53:40+08:00',
    author: { user_openid: 'user-1' }
  })
  assert.equal(message.text, '[QQ表情 0] [图片]')
  assert.equal(message.chatId, 'c2c_user-1')
})

test('inbound group content keeps plain text and cleans tags/entities', () => {
  const message = normalizeDispatch('GROUP_AT_MESSAGE_CREATE', {
    id: 'msg-2',
    group_openid: 'group-1',
    content: '<at id="9">小明</at> 看这个 &amp; 那个',
    timestamp: '2026-11-09T22:55:00+08:00',
    author: { member_openid: 'member-1', member_role: 'member' }
  })
  assert.equal(message.text, '小明 看这个 & 那个')
  assert.equal(message.attachments.length, 0)
})
