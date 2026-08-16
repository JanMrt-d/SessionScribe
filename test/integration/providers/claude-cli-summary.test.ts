import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeCliSummaryAdapter, ProviderError } from '@main/providers'
import type { SummaryRequest } from '@main/providers'
import type { SummaryProfileV1 } from '@shared/providers'
import { profileBase, providerContext, transcriptFixture } from './helpers'

type ClaudeCliProfile = Extract<SummaryProfileV1, { kind: 'claude-cli' }>

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

const MEETING_DRAFT = {
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
      confidence: 0.9,
      evidence: ['utterance-1']
    }
  ],
  openQuestions: [],
  risks: []
}

/**
 * Stands in for the agent CLI. It records the argv and stdin it was given so the
 * test can assert on the contract, then replies in the shape the selected mode
 * asks for. Driven entirely through argv so the child needs no environment.
 */
const FAKE_CLI = `
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const read = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdin += chunk
})
process.stdin.on('end', () => {
  writeFileSync(read('--capture'), JSON.stringify({ args, stdin }))
  const mode = read('--mode')
  if (mode === 'exit-1') {
    process.stderr.write('the agent refused')
    process.exit(1)
  }
  if (mode === 'is-error') {
    process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'quota' }))
    return
  }
  if (mode === 'not-json') {
    process.stdout.write('Sorry, I cannot do that.')
    return
  }
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: read('--summary')
    })
  )
})
`

describe('agent CLI summary provider', () => {
  it('summarizes through the CLI, substituting placeholders and prompting on stdin', async () => {
    const { scriptPath, capturePath } = await fakeCli()
    const transcript = transcriptFixture()
    const profile = claudeCliProfile(scriptPath, [
      '--capture',
      capturePath,
      '--mode',
      'ok',
      '--summary',
      JSON.stringify(MEETING_DRAFT),
      '--model',
      '{model}',
      '--system',
      '{system}'
    ])

    const result = await new ClaudeCliSummaryAdapter().summarize(
      summaryRequest(transcript.sessionId, transcript),
      profile,
      providerContext()
    )

    expect(result.mode).toBe('meeting')
    if (result.mode === 'meeting') {
      // Evidence IDs are hydrated into real transcript timestamps.
      expect(result.actionItems[0]?.evidence[0]).toEqual({
        utteranceId: 'utterance-1',
        startMs: 100,
        endMs: 1_900
      })
    }
    expect(result.provenance).toMatchObject({ providerKind: 'claude-cli', model: 'claude-opus-5' })

    const captured = await capture(capturePath)
    expect(captured.args[captured.args.indexOf('--model') + 1]).toBe('claude-opus-5')
    // The system prompt reached the CLI through its placeholder, not stdin.
    expect(captured.args[captured.args.indexOf('--system') + 1]).toContain('utterance')
    expect(captured.stdin).toContain('Alice owns the release task.')
  })

  it('prepends the system prompt to stdin when no {system} argument is configured', async () => {
    const { scriptPath, capturePath } = await fakeCli()
    const transcript = transcriptFixture()
    const profile = claudeCliProfile(scriptPath, [
      '--capture',
      capturePath,
      '--mode',
      'ok',
      '--summary',
      JSON.stringify(MEETING_DRAFT)
    ])

    await new ClaudeCliSummaryAdapter().summarize(
      summaryRequest(transcript.sessionId, transcript),
      profile,
      providerContext()
    )

    const captured = await capture(capturePath)
    expect(captured.args).not.toContain('--system')
    // Grounding rules must still reach the model, so they lead the stdin payload.
    expect(captured.stdin).toContain('utterance')
    expect(captured.stdin.indexOf('utterance')).toBeLessThan(
      captured.stdin.indexOf('Alice owns the release task.')
    )
  })

  it('reports a failing CLI as a process error rather than invalid output', async () => {
    const { scriptPath, capturePath } = await fakeCli()
    const transcript = transcriptFixture()
    const profile = claudeCliProfile(scriptPath, ['--capture', capturePath, '--mode', 'exit-1'])

    const error = await new ClaudeCliSummaryAdapter()
      .summarize(summaryRequest(transcript.sessionId, transcript), profile, providerContext())
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).code).toBe('PROCESS_FAILED')
    // stderr can echo transcript content, so it must not reach the message.
    expect((error as ProviderError).message).not.toContain('the agent refused')
  })

  it('treats an is_error envelope as a failure instead of summarizing its text', async () => {
    const { scriptPath, capturePath } = await fakeCli()
    const transcript = transcriptFixture()
    const profile = claudeCliProfile(scriptPath, ['--capture', capturePath, '--mode', 'is-error'])

    const error = await new ClaudeCliSummaryAdapter()
      .summarize(summaryRequest(transcript.sessionId, transcript), profile, providerContext())
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).code).toBe('PROCESS_FAILED')
  })

  it('rejects a relative executable before spawning anything', async () => {
    const transcript = transcriptFixture()
    const profile = { ...claudeCliProfile('claude', []), executable: 'claude' }

    const error = await new ClaudeCliSummaryAdapter()
      .summarize(summaryRequest(transcript.sessionId, transcript), profile, providerContext())
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).code).toBe('INVALID_CONFIG')
  })

  it('reports prompt-only structured output so the engine owns validation', () => {
    expect(new ClaudeCliSummaryAdapter().capabilities()).toMatchObject({
      structuredOutput: false,
      modelListing: false
    })
  })
})

async function fakeCli(): Promise<{ scriptPath: string; capturePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'session-scribe-agent-cli-'))
  temporaryDirectories.push(directory)
  const scriptPath = join(directory, 'fake-agent.cjs')
  await writeFile(scriptPath, FAKE_CLI, 'utf8')
  return { scriptPath, capturePath: join(directory, 'capture.json') }
}

async function capture(path: string): Promise<{ args: string[]; stdin: string }> {
  return JSON.parse(await readFile(path, 'utf8')) as { args: string[]; stdin: string }
}

function claudeCliProfile(scriptPath: string, args: readonly string[]): ClaudeCliProfile {
  return {
    ...profileBase('claude-opus-5'),
    task: 'summary',
    kind: 'claude-cli',
    // Node itself stands in for the agent binary so the test needs nothing installed.
    executable: process.execPath,
    args: [scriptPath, ...args],
    outputEnvelope: 'claude-json',
    inheritEnvironment: false,
    contextWindowTokens: 8_192,
    meetingPromptOverride: null,
    lecturePromptOverride: null
  }
}

function summaryRequest(
  sessionId: string,
  transcript: ReturnType<typeof transcriptFixture>
): SummaryRequest {
  return { sessionId, title: 'Release meeting', mode: 'meeting', revision: 1, transcript }
}
