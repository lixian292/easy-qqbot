/** Lead-owned tests for shared media attachment helpers. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyAttachment, mediaDownloadUrl, attachmentAsrText, describeMediaMarker, describeMediaWithText } from '../host/util/media.js'

test('classifyAttachment recognizes images, voices, videos and files', () => {
  assert.equal(classifyAttachment({ contentType: 'image/jpeg' }), 'image')
  assert.equal(classifyAttachment({ contentType: 'sticker' }), 'image')
  assert.equal(classifyAttachment({ url: 'https://x/a.png' }), 'image')
  assert.equal(classifyAttachment({ contentType: 'voice', url: 'https://x/a.silk', voiceWavUrl: 'https://x/a.wav' }), 'audio')
  assert.equal(classifyAttachment({ contentType: 'audio/ogg' }), 'audio')
  assert.equal(classifyAttachment({ contentType: 'video/mp4' }), 'video')
  assert.equal(classifyAttachment({ filename: 'clip.mp4' }), 'video')
  assert.equal(classifyAttachment({ contentType: 'file' }), 'file')
  assert.equal(classifyAttachment({}), 'other')
  assert.equal(classifyAttachment(null), 'other')
})

test('mediaDownloadUrl prefers the WAV voice URL and ASR hint is exposed', () => {
  assert.equal(
    mediaDownloadUrl({ contentType: 'voice', url: 'https://x/a.silk', voiceWavUrl: 'https://x/a.wav' }),
    'https://x/a.wav'
  )
  assert.equal(mediaDownloadUrl({ contentType: 'image/png', url: 'https://x/a.png' }), 'https://x/a.png')
  assert.equal(mediaDownloadUrl({}), '')
  assert.equal(attachmentAsrText({ asrReferText: ' 你好 ' }), '你好')
})

test('media markers add readable kind/type content', () => {
  assert.equal(describeMediaMarker({ contentType: 'image/jpeg', width: 800, height: 600 }), '[图片 800×600 image/jpeg]')
  assert.equal(describeMediaMarker({ contentType: 'voice' }), '[语音]')
  assert.equal(describeMediaMarker({ contentType: 'video/mp4' }), '[视频 video/mp4]')
  assert.equal(describeMediaMarker({ contentType: 'file' }), '[文件]')
  assert.equal(
    describeMediaWithText({ contentType: 'image/png', width: 10, height: 10 }, '一只猫'),
    '[图片 10×10 image/png]（图片内容：一只猫）'
  )
  assert.equal(describeMediaWithText({ contentType: 'voice' }, '  你好呀  '), '[语音]（语音内容：你好呀）')
  assert.equal(describeMediaWithText({ contentType: 'video/mp4' }, '一段视频'), '[视频 video/mp4]（视频内容：一段视频）')
  assert.equal(describeMediaWithText({ contentType: 'image/png' }, ''), '[图片 image/png]')
})
