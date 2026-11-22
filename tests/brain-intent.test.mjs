/** Tests for host/brain/intent.js — media-generation intent detection. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeGenerationRequest } from '../host/brain/intent.js'

test('detects common image/voice/video generation requests', () => {
  for (const text of [
    '小蓝，自拍一张给他们瞅瞅',
    '用新衣服拍个照看看',
    '生成一张自拍',
    '画小蓝在海边',
    '给我画一张头像',
    '发我一张照片',
    '来张壁纸',
    '发一段语音听听',
    '生成一个视频',
    'generate an image of a whale',
    'draw yourself'
  ]) {
    assert.equal(looksLikeGenerationRequest(text), true, text)
  }
})

test('does not treat ordinary chat or sticker requests as media generation', () => {
  for (const text of ['今天天气不错', '发个表情包', '你画的饼真好吃', '', '   ', '晚安啦']) {
    assert.equal(looksLikeGenerationRequest(text), false, text)
  }
})
