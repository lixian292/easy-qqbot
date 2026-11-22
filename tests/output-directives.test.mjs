/** Tests for host/output/directives.js — model-requested generation markers. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOutputInstruction, parseOutputDirectives } from '../host/output/directives.js'

test('parseOutputDirectives extracts image / voice / video prompts and removes them', () => {
  const result = parseOutputDirectives(
    '给你画好啦 [[image: 一只橘猫坐在窗台上]]\n晚安 [[voice: 做个好梦]] [[video：海边日落]]'
  )
  assert.deepEqual(result.requests, [
    { kind: 'image', prompt: '一只橘猫坐在窗台上' },
    { kind: 'audio', prompt: '做个好梦' },
    { kind: 'video', prompt: '海边日落' }
  ])
  assert.equal(result.text.includes('[['), false)
  assert.equal(result.text.includes('给你画好啦'), true)
})

test('parseOutputDirectives ignores malformed and sticker directives', () => {
  const result = parseOutputDirectives('[[image]] [[sticker: 开心]] [[voice: ]] 普通文本')
  assert.deepEqual(result.requests, [])
  assert.equal(result.text.includes('[[sticker: 开心]]'), true)
  assert.equal(result.text.includes('普通文本'), true)
})

test('buildOutputInstruction is gated by enable flags and lists enabled kinds only', () => {
  assert.equal(buildOutputInstruction({ output: { enabled: true, allowModelDirectives: false } }), '')
  assert.equal(buildOutputInstruction({ output: { enabled: false, allowModelDirectives: true } }), '')

  const instruction = buildOutputInstruction({
    output: {
      enabled: true,
      allowModelDirectives: true,
      image: { enabled: true },
      audio: { enabled: false },
      video: { enabled: true }
    }
  })
  assert.ok(instruction.includes('[[image:'))
  assert.ok(instruction.includes('[[video:'))
  assert.equal(instruction.includes('[[voice:'), false)
  assert.ok(instruction.includes('最多使用一个'))
})
