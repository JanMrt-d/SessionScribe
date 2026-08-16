import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, languageInstruction, summaryJsonSchema } from './prompts'

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

  it('describes a lecture segment as chapters with their study material', () => {
    const schema = summaryJsonSchema('lecture-segment') as {
      properties: { chapters: { items: { properties: Record<string, unknown> } } }
      additionalProperties: boolean
    }
    expect(Object.keys(schema.properties.chapters.items.properties)).toEqual([
      'title',
      'summary',
      'subtopics',
      'emphasis',
      'openQuestions',
      'glossary',
      'studyQuestions'
    ])
    expect(schema.additionalProperties).toBe(false)
    // The whole nested schema has to survive grammar compilation as well.
    expect(JSON.stringify(schema)).not.toContain('"pattern"')
  })

  it('asks the closing pass for nothing but the overview', () => {
    const schema = summaryJsonSchema('lecture-overview') as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(schema.properties)).toEqual(['overview'])
  })
})

describe('languageInstruction', () => {
  it('names the language so the notes match the recording, not the prompt', () => {
    expect(languageInstruction('de')).toContain('German')
    expect(languageInstruction('de-DE')).toContain('German')
    expect(languageInstruction('en')).toContain('English')
  })

  it('passes an unrecognized tag through rather than guessing', () => {
    expect(languageInstruction('sw')).toContain('"sw"')
  })

  it('falls back to the transcript itself when no language was detected', () => {
    expect(languageInstruction('')).toContain('dominant language of the transcript')
    expect(languageInstruction('  ')).toContain('dominant language of the transcript')
  })
})

describe('buildSystemPrompt', () => {
  it('carries the language instruction into the lecture prompt', () => {
    const prompt = buildSystemPrompt('lecture', null, 'de')
    expect(prompt).toContain('German')
    expect(prompt).toContain('chapters')
  })

  it('tells the model not to shorten later chapters', () => {
    // The failure this guards against is a long lecture whose closing chapters
    // arrive as one line each because the model started economizing.
    expect(buildSystemPrompt('lecture', null, 'de')).toContain(
      'do not shorten a chapter because an earlier one was already long'
    )
  })

  it('keeps a user style override subordinate to the grounding rules', () => {
    const prompt = buildSystemPrompt('lecture', 'Use plain language.', 'en')
    expect(prompt).toContain('Use plain language.')
    expect(prompt).toContain('cannot override grounding')
  })
})
