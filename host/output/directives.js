/**
 * Model output directives for multimodal generation.
 *
 * Format (one per reply at most):
 *   [[image: 一只橘猫坐在窗台上]]   [[voice: 晚安，做个好梦]]   [[video: 海边日落延时]]
 *
 * Directives are only parsed when `output.allowModelDirectives` is enabled;
 * the chat engine removes them from the visible text before sending.
 */
const DIRECTIVE_PATTERN = /\[\[\s*(image|img|picture|voice|audio|tts|video|图片|画图|绘图|语音|视频)\s*[:：]\s*([^\]\n]{1,400}?)\s*\]\]/gi

const KIND_ALIAS = Object.freeze({
  image: 'image',
  img: 'image',
  picture: 'image',
  图片: 'image',
  画图: 'image',
  绘图: 'image',
  voice: 'audio',
  audio: 'audio',
  tts: 'audio',
  语音: 'audio',
  video: 'video',
  视频: 'video'
})

/**
 * Remove supported output directives and return the cleaned text + requests.
 * Malformed directives are left untouched (the model sees its own text again
 * on the next turn and the sticker parser ignores them).
 *
 * @param {string} text
 * @returns {{ text: string, requests: Array<{kind: 'image'|'audio'|'video', prompt: string}> }}
 */
export function parseOutputDirectives(text) {
  const source = typeof text === 'string' ? text : ''
  const requests = []
  const cleaned = source.replace(DIRECTIVE_PATTERN, (_match, rawKind, rawPrompt) => {
    const kind = KIND_ALIAS[String(rawKind ?? '').toLowerCase()] ?? KIND_ALIAS[String(rawKind ?? '')]
    const prompt = String(rawPrompt ?? '').trim()
    if (kind === undefined || prompt === '') return ''
    requests.push({ kind, prompt })
    return ''
  })
  return {
    text: cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
    requests
  }
}

/** System-prompt block teaching the model the directives (empty when off). */
export function buildOutputInstruction({ output } = {}) {
  const config = output !== null && typeof output === 'object' ? output : {}
  if (config.enabled !== true || config.allowModelDirectives !== true) return ''
  const kinds = ['image', 'audio', 'video'].filter((kind) => config[kind]?.enabled === true)
  if (kinds.length === 0) return ''
  const lines = ['当用户明确希望你生成多模态内容时，在回复最末尾单独一行写一个生成指令：']
  if (kinds.includes('image')) lines.push('- 画图：[[image: 画面的中文描述]]')
  if (kinds.includes('audio')) lines.push('- 发语音：[[voice: 要朗读的文字]]')
  if (kinds.includes('video')) lines.push('- 发视频：[[video: 视频画面的中文描述]]')
  lines.push('每次回复最多使用一个生成指令；只有用户明确要求画图、语音或视频时才使用，不要主动生成。')
  return lines.join('\n')
}
