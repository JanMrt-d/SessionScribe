import log from 'electron-log/main'

const sensitiveKeys = /authorization|api[-_]?key|password|secret|token|transcript|summary|prompt/i

log.initialize()
log.transports.file.maxSize = 5 * 1024 * 1024
log.hooks.push((message) => {
  message.data = message.data.map((item) => redact(item))
  return message
})

export const logger = log.scope('sessionscribe')

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = sensitiveKeys.test(key) ? '[REDACTED]' : redact(item)
  }
  return output
}
