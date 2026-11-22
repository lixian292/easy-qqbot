/**
 * Typed errors for the optional multimodal output feature (image / speech /
 * video generation through third-party APIs).
 *
 * `code` is stable and safe for the admin page to switch on; provider response
 * text is only included after truncation so a huge HTML error page cannot flood
 * the UI or the logs.
 */
export class OutputError extends Error {
  constructor(message, { code = 'OUTPUT_ERROR', status = 0, cause } = {}) {
    super(String(message ?? '多模态输出错误'), cause === undefined ? undefined : { cause })
    this.name = 'OutputError'
    this.code = code
    this.status = Number(status) || 0
  }
}

/** Collapse whitespace and cap a provider message for logs / admin display. */
export function shortMessage(value, maxLength = 200) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}
