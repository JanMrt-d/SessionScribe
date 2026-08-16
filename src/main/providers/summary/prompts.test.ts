import { describe, expect, it } from 'vitest'
import { summaryJsonSchema } from './prompts'

describe('summaryJsonSchema', () => {
  it('keeps the date-time format but drops the regex pattern Ollama cannot compile', () => {
    const serialized = JSON.stringify(summaryJsonSchema('meeting'))
    expect(serialized).toContain('"format":"date-time"')
    expect(serialized).not.toContain('"pattern"')
  })

  it('still describes the strict meeting shape', () => {
    const schema = summaryJsonSchema('meeting') as {
      properties: Record<string, unknown>
      additionalProperties: boolean
    }
    expect(Object.keys(schema.properties)).toEqual([
      'overview',
      'topics',
      'decisions',
      'actionItems',
      'openQuestions',
      'risks'
    ])
    expect(schema.additionalProperties).toBe(false)
  })
})
