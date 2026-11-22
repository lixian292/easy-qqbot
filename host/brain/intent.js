/**
 * Lightweight intent heuristics for the chat pipeline.
 *
 * Sticker replies are a decorative side effect. When the user is asking for a
 * generated image / voice / video, adding a random sticker on top of the
 * generated media almost always looks out of place, so the chat engine uses
 * this helper to suppress sticker selection for that turn.
 */
const GENERATION_PATTERNS = [
  /自拍|拍照|拍个?照|拍一?张|拍张|拍一段/,
  /(?:来|发|整|做|画|生成|制作|绘制)(?:一|两|三|个|张|幅|段|条|份)?(?:图|照片|相片|自拍|头像|壁纸|插画|海报|配图|画面|视频|语音|配音)/,
  /(?:发|来|给|拍|画|生成).{0,6}(?:图|照片|相片|自拍|头像|壁纸|插画|海报|视频|语音)/,
  /(?:再来|再画|再生成)(?:一|两|个|张|幅|段|条)?(?:图|照片|自拍|视频|语音)?/,
  /画(?:一|个|张|幅|只|你|我|小蓝|鲸鱼娘)/,
  /(?:生成|绘制)(?:.*)(?:图|画|视频|语音|你)/,
  /(?:看看|瞅瞅)(?:你|小蓝|鲸鱼娘)(?:的)?(?:样子|照片|自拍|新衣服)?/,
  /(?:视频|语音|配音|tts)\b|(?:视频|语音|配音)/i,
  /\b(?:image|draw|generate|picture|photo|selfie|avatar|wallpaper|tts|video)\b/i
]

/**
 * Does this user message ask the bot to produce media (image/audio/video)?
 * Pure text chat, including "发个表情包", intentionally returns false.
 */
export function looksLikeGenerationRequest(text) {
  const value = String(text ?? '').trim()
  if (value === '') return false
  return GENERATION_PATTERNS.some((pattern) => pattern.test(value))
}
