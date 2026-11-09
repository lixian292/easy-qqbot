/**
 * Pure prompt assembly helpers for the qqbot brain.
 *
 * Everything here is a plain function: no IO, no LLM access, no global state.
 * The chat engine calls these to build the system prompt and the message list
 * handed to `llmClient.complete()`.
 */
import { formatDateTime } from '../util/text.js'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Normalize a facts list (strings or `{text}` objects) into trimmed strings. */
function factTexts(facts) {
  const out = []
  for (const item of Array.isArray(facts) ? facts : []) {
    const text = typeof item === 'string' ? item : isPlainObject(item) ? String(item.text ?? '') : ''
    const trimmed = text.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out
}

/** Summary input may be the stored object or a plain string. */
function summaryText(summary) {
  if (typeof summary === 'string') return summary.trim()
  if (isPlainObject(summary)) return String(summary.text ?? '').trim()
  return ''
}

/**
 * Instruction block that teaches the model the `[[sticker: 标签]]` directive.
 * Returns '' when there is no usable catalog or stickers are disabled.
 *
 * @param {{ stickerCatalog?: string, stickerChance?: number }} [options]
 */
export function buildStickerInstruction({ stickerCatalog, stickerChance } = {}) {
  const catalog = typeof stickerCatalog === 'string' ? stickerCatalog.trim() : ''
  if (catalog === '') return ''
  const chance = Number(stickerChance)
  if (Number.isFinite(chance) && chance <= 0) return ''
  const lines = [
    `可用表情包标签：${catalog}`,
    '当回复适合配一张表情包时，在回复最末尾单独加一行：[[sticker: 标签1, 标签2]]。',
    '标签必须来自上面的列表（最多两个）；不确定或氛围不合适就不要加。'
  ]
  if (Number.isFinite(chance) && chance > 0 && chance < 1) {
    lines.push(`表情包只是偶尔点缀，大约 ${Math.max(1, Math.round(chance * 100))}% 的回复里出现就够了，不要每句都配。`)
  }
  return lines.join('\n')
}

/**
 * Build the full system prompt: persona, style, time, long-term facts,
 * dialogue summary and the sticker directive (only when enabled + non-empty).
 *
 * @param {{ config?: object, persona?: object, facts?: Array<string|object>, summary?: object|string, stickerCatalog?: string, now?: number }} [options]
 * @returns {string}
 */
export function buildSystemPrompt({ config, persona, facts = [], summary, stickerCatalog, now = Date.now() } = {}) {
  const configObject = isPlainObject(config) ? config : {}
  const basePersona = isPlainObject(configObject.persona) ? configObject.persona : {}
  const override = isPlainObject(persona) ? persona : {}
  const effective = { ...basePersona, ...override }

  const name = String(effective.name ?? basePersona.name ?? '小Q').trim() || '小Q'
  const sections = [`你现在扮演「${name}」，正在 QQ 上和用户聊天。`]

  const systemPrompt = String(effective.systemPrompt ?? '').trim()
  if (systemPrompt !== '') sections.push(systemPrompt)

  const style = String(effective.style ?? '').trim()
  if (style !== '') sections.push(`说话风格：${style}`)

  const extraPrompt = String(effective.extraPrompt ?? '').trim()
  if (extraPrompt !== '') sections.push(extraPrompt)

  sections.push(`当前时间：${formatDateTime(now)}`)

  const remembered = factTexts(facts)
  if (remembered.length > 0) {
    sections.push(`【长期记忆】\n${remembered.map((text) => `- ${text}`).join('\n')}`)
  }

  const dialogueSummary = summaryText(summary)
  if (dialogueSummary !== '') sections.push(`【之前的对话摘要】\n${dialogueSummary}`)

  if (configObject.stickers?.enabled === true) {
    const stickerInstruction = buildStickerInstruction({ stickerCatalog, stickerChance: effective.stickerChance })
    if (stickerInstruction !== '') sections.push(`【表情包】\n${stickerInstruction}`)
  }

  sections.push('输出要求：只输出纯文本，不要使用 Markdown（不要标题、列表、代码块、粗体或链接语法）；像真人聊天一样直接说话，不要解释你是模型。')

  return sections.join('\n\n')
}

/**
 * Turn stored ChatMessage history into LLM messages and append the new user
 * message. Keeps at most `maxMessages` history entries (oldest dropped first).
 *
 * @param {{ history?: object[], userMessage?: string, maxMessages?: number }} [options]
 * @returns {{ role: 'user'|'assistant', content: string }[]}
 */
export function buildMessages({ history, userMessage, maxMessages } = {}) {
  const converted = []
  for (const message of Array.isArray(history) ? history : []) {
    if (!isPlainObject(message)) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const content = String(message.content ?? '').trim()
    if (content === '') continue
    converted.push({ role: message.role, content })
  }

  const limit = Number(maxMessages)
  const selected = Number.isFinite(limit) && limit > 0 && converted.length > limit ? converted.slice(-limit) : converted

  const lastUserMessage = userMessage === undefined || userMessage === null ? '' : String(userMessage)
  if (lastUserMessage.trim() !== '') return [...selected, { role: 'user', content: lastUserMessage }]
  return selected
}
