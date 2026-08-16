import { afterEach, describe, expect, it } from 'vitest'
import {
  OllamaSummaryAdapter,
  OpenAiCompatibleSummaryAdapter,
  ProviderError
} from '@main/providers'
import type { SummaryRequest } from '@main/providers'
import type { SummaryProfileV1 } from '@shared/providers'
import {
  profileBase,
  providerContext,
  readRequestBody,
  startFixtureServer,
  transcriptFixture,
  type FixtureServer
} from './helpers'

const cleanupServers: FixtureServer[] = []

afterEach(async () => {
  await Promise.all(cleanupServers.splice(0).map((server) => server.close()))
})

describe('summary providers', () => {
  it('repairs invalid meeting evidence and hydrates canonical timestamps', async () => {
    let requests = 0
    let arbitraryModelWasSent = false
    const fixture = await startFixtureServer(async (httpRequest, response) => {
      requests += 1
      const requestBody = JSON.parse(
        (await readRequestBody(httpRequest)).toString('utf8')
      ) as Record<string, unknown>
      arbitraryModelWasSent = requestBody.model === 'future-provider/model:42'
      const summary = {
        overview: 'Alice owns the release task.',
        topics: [{ text: 'Release work', evidence: ['utterance-1'] }],
        decisions: [],
        actionItems: [
          {
            task: 'Complete the release',
            assignee: 'Alice',
            explicitAssignment: true,
            dueAt: null,
            dueText: null,
            confidence: 0.95,
            evidence: [requests === 1 ? 'invented-id' : 'utterance-1']
          }
        ],
        openQuestions: [],
        risks: []
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(summary) } }] }))
    })
    cleanupServers.push(fixture)
    const transcript = transcriptFixture()
    const profile: Extract<SummaryProfileV1, { kind: 'openai-compatible' }> = {
      ...profileBase('future-provider/model:42'),
      task: 'summary',
      kind: 'openai-compatible',
      baseUrl: `${fixture.baseUrl}/v77`,
      apiStyle: 'chat-completions',
      structuredOutput: 'json-schema',
      contextWindowTokens: 8_192,
      extraBody: { temperature: 0 },
      meetingPromptOverride: null,
      lecturePromptOverride: null
    }
    const result = await new OpenAiCompatibleSummaryAdapter().summarize(
      summaryRequest(transcript.sessionId, transcript, 'meeting'),
      profile,
      providerContext()
    )

    expect(requests).toBe(2)
    expect(arbitraryModelWasSent).toBe(true)
    expect(result.mode).toBe('meeting')
    if (result.mode === 'meeting') {
      expect(result.actionItems[0]?.evidence[0]).toEqual({
        utteranceId: 'utterance-1',
        startMs: 100,
        endMs: 1_900
      })
    }
  })

  it('creates grounded lecture notes through an Ollama-compatible endpoint', async () => {
    let receivedPath = ''
    const fixture = await startFixtureServer(async (httpRequest, response) => {
      receivedPath = httpRequest.url ?? ''
      const requestBody = JSON.parse(
        (await readRequestBody(httpRequest)).toString('utf8')
      ) as Record<string, unknown>
      expect(requestBody.model).toBe('local/lecture-model:latest')
      expect(requestBody.format).toBeTypeOf('object')
      expect(requestBody.options).toMatchObject({ temperature: 0 })
      // Lecture notes are produced in two shapes: chapters per segment, then a
      // closing overview. The requested schema says which one is due.
      const wantsChapters = JSON.stringify(requestBody.format).includes('chapters')
      const summary = wantsChapters
        ? {
            chapters: [
              {
                title: 'Task ownership',
                summary: 'The lecture established who owns the release task.',
                subtopics: [
                  {
                    title: 'Explicit assignment',
                    keyPoints: [{ text: 'State ownership clearly.', evidence: ['utterance-1'] }]
                  }
                ],
                emphasis: [{ text: 'Ownership must be explicit.', evidence: ['utterance-1'] }],
                openQuestions: [],
                glossary: [
                  {
                    name: 'Ownership',
                    definition: 'A named person is responsible.',
                    evidence: ['utterance-1']
                  }
                ],
                studyQuestions: [
                  {
                    question: 'Who owns the release task?',
                    answer: 'Alice owns it.',
                    evidence: ['utterance-1']
                  }
                ]
              }
            ]
          }
        : { overview: 'Ownership is explicit.' }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ message: { content: JSON.stringify(summary) } }))
    })
    cleanupServers.push(fixture)
    const transcript = transcriptFixture()
    const profile: Extract<SummaryProfileV1, { kind: 'ollama' }> = {
      ...profileBase('local/lecture-model:latest'),
      task: 'summary',
      kind: 'ollama',
      baseUrl: `${fixture.baseUrl}/custom`,
      contextWindowTokens: 4_096,
      numPredict: 2_000,
      meetingPromptOverride: null,
      lecturePromptOverride: 'Use concise teaching language.'
    }
    const result = await new OllamaSummaryAdapter().summarize(
      summaryRequest(transcript.sessionId, transcript, 'lecture'),
      profile,
      providerContext()
    )
    expect(receivedPath).toBe('/custom/api/chat')
    expect(result.mode).toBe('lecture')
    if (result.mode === 'lecture') {
      expect(result.overview).toBe('Ownership is explicit.')
      expect(result.chapters).toHaveLength(1)
      expect(result.chapters[0]?.subtopics[0]?.keyPoints).toHaveLength(1)
      expect(result.chapters[0]?.studyQuestions[0]?.answer).toBe('Alice owns it.')
      // Resolved from the cited utterance, never taken from the model.
      expect(result.chapters[0]?.startMs).toBe(100)
    }
  })

  it('rejects transcript text without evidence-addressable utterances', async () => {
    const transcript = { ...transcriptFixture(), utterances: [] }
    const profile: Extract<SummaryProfileV1, { kind: 'ollama' }> = {
      ...profileBase('model'),
      task: 'summary',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      contextWindowTokens: 2_048,
      numPredict: null,
      meetingPromptOverride: null,
      lecturePromptOverride: null
    }
    await expect(
      new OllamaSummaryAdapter().summarize(
        summaryRequest(transcript.sessionId, transcript, 'lecture'),
        profile,
        providerContext()
      )
    ).rejects.toBeInstanceOf(ProviderError)
  })
})

function summaryRequest(
  sessionId: string,
  transcript: ReturnType<typeof transcriptFixture>,
  mode: 'meeting' | 'lecture'
): SummaryRequest {
  return {
    sessionId,
    title: mode === 'meeting' ? 'Release meeting' : 'Ownership lecture',
    mode,
    revision: 1,
    transcript
  }
}
