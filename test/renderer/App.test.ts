// @vitest-environment jsdom
/// <reference lib="dom" />

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/src/App'
import { NewSessionDialog } from '../../src/renderer/src/components/NewSessionDialog'
import type { SessionScribeApi } from '../../src/shared/ipc'
import {
  JOB_ID,
  SUMMARY_PROFILE_ID,
  createMockApi,
  profilesFixture,
  sessionFixture,
  transcriptFixture
} from './mockApi'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderApp(api = createMockApi()): ReturnType<typeof render> {
  Object.defineProperty(window, 'sessionScribe', {
    configurable: true,
    value: api satisfies SessionScribeApi
  })
  return render(React.createElement(App))
}

describe('renderer workbench', () => {
  it('loads the session library and selected transcript', async () => {
    renderApp()

    expect(await screen.findByRole('heading', { name: 'Design sync' })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: 'Conversation' })).toBeTruthy()
    expect(screen.getByDisplayValue('We will ship the proposal Friday.')).toBeTruthy()
    expect(screen.getByText('The provider rate limit was reached.')).toBeTruthy()
  })

  it('creates a lecture recording from the new-session dialog', async () => {
    const api = createMockApi()
    const user = userEvent.setup()
    renderApp(api)

    await screen.findByRole('heading', { name: 'Design sync' })
    await user.click(screen.getByRole('button', { name: 'New recording' }))
    await user.type(screen.getByLabelText('Session title'), 'Distributed systems lecture')
    await user.click(screen.getByRole('button', { name: 'Lecture' }))
    await user.click(screen.getByRole('button', { name: 'Set up recording' }))

    await waitFor(() => {
      expect(api.sessions.create).toHaveBeenCalledWith({
        title: 'Distributed systems lecture',
        mode: 'lecture'
      })
    })
  })

  it('retries a failed persistent pipeline job', async () => {
    const api = createMockApi()
    const user = userEvent.setup()
    renderApp(api)

    await screen.findByText('The provider rate limit was reached.')
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(api.jobs.retry).toHaveBeenCalledWith(JOB_ID))
  })

  it('infers completed pipeline stages from the durable job stage', async () => {
    renderApp()

    await screen.findByText('The provider rate limit was reached.')
    const inspectStage = screen.getByText('Inspect media').closest('li')

    expect(inspectStage).toBeTruthy()
    expect(within(inspectStage as HTMLElement).getByText('Complete')).toBeTruthy()
    expect(screen.getByText('Attempt 1 failed')).toBeTruthy()
  })

  it('saves edited utterances through the transcript API', async () => {
    const api = createMockApi()
    const user = userEvent.setup()
    renderApp(api)

    const utterance = await screen.findByLabelText('Transcript at 0:12')
    await user.clear(utterance)
    await user.type(utterance, 'We will deliver the proposal on Friday.')
    await user.click(screen.getByRole('button', { name: 'Save transcript' }))

    await waitFor(() => {
      expect(api.transcript.save).toHaveBeenCalledTimes(1)
      const call = vi.mocked(api.transcript.save).mock.calls[0]?.[0]
      expect(call?.sessionId).toBe(sessionFixture.id)
      expect(call?.document.utterances[0]?.text).toBe('We will deliver the proposal on Friday.')
      expect(call?.document.utterances[0]?.manuallyEdited).toBe(true)
      expect(call?.document.text).not.toBe(transcriptFixture.text)
    })
  })

  it('persists dirty utterances before renaming a speaker', async () => {
    const api = createMockApi()
    let persisted = structuredClone(transcriptFixture)
    vi.mocked(api.transcript.save).mockImplementation(async (input) => {
      persisted = structuredClone(input.document)
      return persisted
    })
    vi.mocked(api.transcript.renameSpeaker).mockImplementation(async (input) => {
      persisted = {
        ...persisted,
        speakers: persisted.speakers.map((speaker) =>
          speaker.id === input.speakerId ? { ...speaker, displayName: input.displayName } : speaker
        )
      }
      return persisted
    })
    const user = userEvent.setup()
    renderApp(api)

    const utterance = await screen.findByLabelText('Transcript at 0:12')
    await user.clear(utterance)
    await user.type(utterance, 'The proposal ships next Friday.')
    await user.click(screen.getByText('Rename or merge speakers'))
    const speakerName = screen.getByDisplayValue('Alex')
    await user.clear(speakerName)
    await user.type(speakerName, 'Alicia')
    await user.click(screen.getAllByRole('button', { name: 'Apply' })[0] as HTMLElement)

    await waitFor(() => {
      expect(api.transcript.save).toHaveBeenCalledTimes(1)
      expect(api.transcript.renameSpeaker).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(api.transcript.save).mock.invocationCallOrder[0] as number).toBeLessThan(
      vi.mocked(api.transcript.renameSpeaker).mock.invocationCallOrder[0] as number
    )
    expect(screen.getByLabelText<HTMLTextAreaElement>('Transcript at 0:12').value).toBe(
      'The proposal ships next Friday.'
    )
  })

  it('keeps editable summary and provider field focus while typing', async () => {
    const user = userEvent.setup()
    renderApp()

    await screen.findByRole('heading', { name: 'Design sync' })
    await user.click(screen.getByRole('tab', { name: /Summary/ }))
    const decision = screen.getByLabelText('Decisions item 1')
    await user.type(decision, ' updated')
    const currentDecision = screen.getByLabelText<HTMLTextAreaElement>('Decisions item 1')
    expect(currentDecision.value).toBe('Ship Friday updated')
    expect(document.activeElement).toBe(currentDecision)

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    const secretName = await screen.findByLabelText('Secrets field name 1')
    await user.clear(secretName)
    await user.type(secretName, 'token')
    const currentSecretName = screen.getByLabelText<HTMLInputElement>('Secrets field name 1')
    expect(currentSecretName.value).toBe('token')
    expect(document.activeElement).toBe(currentSecretName)
  })

  it('falls back when a selected import provider was deleted', async () => {
    const user = userEvent.setup()
    const onImport = vi.fn(async () => sessionFixture)
    const onOpenChange = vi.fn()
    const commonProps = {
      open: true,
      initialSource: 'import' as const,
      onOpenChange,
      onCreate: vi.fn(async () => sessionFixture),
      onImport
    }
    const view = render(
      React.createElement(NewSessionDialog, { ...commonProps, profiles: profilesFixture })
    )
    const replacementId = '77777777-7777-4777-8777-777777777777'
    const replacement = { ...profilesFixture[0]!, id: replacementId }

    view.rerender(
      React.createElement(NewSessionDialog, {
        ...commonProps,
        profiles: [replacement, profilesFixture[1]!]
      })
    )
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Choose media' })
    await waitFor(() => expect(submit.disabled).toBe(false))
    await user.click(submit)

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledWith({
        mode: 'meeting',
        transcriptionProfileId: replacementId,
        summaryProfileId: SUMMARY_PROFILE_ID
      })
    })
  })
})
