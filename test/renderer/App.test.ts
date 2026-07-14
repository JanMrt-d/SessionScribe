// @vitest-environment jsdom
/// <reference lib="dom" />

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/src/App'
import {
  CaptureWorkspace,
  ObsConnectionDialog
} from '../../src/renderer/src/components/CaptureWorkspace'
import { NewSessionDialog } from '../../src/renderer/src/components/NewSessionDialog'
import type { SessionScribeApi } from '../../src/shared/ipc'
import {
  JOB_ID,
  SUMMARY_PROFILE_ID,
  captureFixture,
  createMockApi,
  managedWhisperProfileFixture,
  profilesFixture,
  sessionFixture,
  transcriptFixture,
  whisperStatusFixture
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
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: {
      configurable: true,
      value: vi.fn(() => false)
    },
    setPointerCapture: {
      configurable: true,
      value: vi.fn()
    },
    releasePointerCapture: {
      configurable: true,
      value: vi.fn()
    },
    scrollIntoView: {
      configurable: true,
      value: vi.fn()
    }
  })
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

  it('installs managed Whisper from the persistent sidebar and refreshes profiles', async () => {
    const api = createMockApi()
    vi.mocked(api.providers.list)
      .mockResolvedValueOnce(profilesFixture)
      .mockResolvedValueOnce([...profilesFixture, managedWhisperProfileFixture])
    const user = userEvent.setup()
    renderApp(api)

    await user.click(await screen.findByRole('button', { name: 'Set up Whisper' }))

    await waitFor(() => expect(api.whisper.install).toHaveBeenCalledOnce())
    await waitFor(() => expect(api.providers.list).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'Start Whisper' })).toBeTruthy()
    expect(screen.getByText('Stopped · VRAM released')).toBeTruthy()
  })

  it('starts an installed Whisper service from the persistent accessible control', async () => {
    const api = createMockApi()
    vi.mocked(api.whisper.status).mockResolvedValue({
      ...whisperStatusFixture,
      phase: 'stopped',
      message: 'Whisper is installed and stopped.',
      installed: true,
      canInstall: false,
      canStart: true
    })
    const user = userEvent.setup()
    renderApp(api)

    const control = await screen.findByRole('region', { name: 'Local Whisper' })
    await user.click(within(control).getByRole('button', { name: 'Start Whisper' }))

    await waitFor(() => expect(api.whisper.start).toHaveBeenCalledOnce())
    expect(within(control).getByText('Ready · using VRAM')).toBeTruthy()
  })

  it('tracks managed Whisper events and stops the ready service', async () => {
    const api = createMockApi()
    const user = userEvent.setup()
    renderApp(api)
    await screen.findByRole('heading', { name: 'Design sync' })

    api.emit({
      type: 'whisper-status',
      payload: {
        ...whisperStatusFixture,
        phase: 'ready',
        message: 'Whisper is ready.',
        installed: true,
        canInstall: false,
        canStop: true
      }
    })
    await user.click(await screen.findByRole('button', { name: 'Stop Whisper' }))

    await waitFor(() => expect(api.whisper.stop).toHaveBeenCalledOnce())
    expect(await screen.findByText('Stopped · VRAM released')).toBeTruthy()
  })

  it('shows managed Whisper installation progress and cancels setup from Settings', async () => {
    const api = createMockApi()
    const user = userEvent.setup()
    renderApp(api)
    await screen.findByRole('heading', { name: 'Design sync' })
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    const dialog = await screen.findByRole('dialog', { name: 'Provider settings' })

    api.emit({
      type: 'whisper-status',
      payload: {
        ...whisperStatusFixture,
        phase: 'installing',
        message: 'Downloading Whisper Large-v3.',
        progress: {
          step: 'downloading-model',
          completedBytes: 1_500_000_000,
          totalBytes: 3_000_000_000
        },
        canInstall: false
      }
    })

    const progress = await within(dialog).findByRole('progressbar', {
      name: 'Whisper installation progress'
    })
    expect(progress.getAttribute('aria-valuenow')).toBe('50')
    expect(within(dialog).getByText('Downloading Large-v3')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel setup' }))
    await waitFor(() => expect(api.whisper.cancelInstall).toHaveBeenCalledOnce())
  })

  it('shows actionable Docker permission diagnostics in Provider settings', async () => {
    const api = createMockApi()
    vi.mocked(api.whisper.status).mockResolvedValue({
      ...whisperStatusFixture,
      phase: 'permission-denied',
      message: 'SessionScribe cannot access the Docker daemon.',
      canInstall: false
    })
    const user = userEvent.setup()
    renderApp(api)
    await screen.findByRole('heading', { name: 'Design sync' })
    await user.click(screen.getByRole('button', { name: 'Settings' }))

    const dialog = await screen.findByRole('dialog', { name: 'Provider settings' })
    const control = within(dialog).getByRole('region', { name: 'Local Whisper' })
    expect(within(control).getByText('Docker permission required')).toBeTruthy()
    expect(within(control).getByText(/Configure rootless Docker/)).toBeTruthy()
    expect(within(control).queryByRole('button', { name: 'Set up Whisper' })).toBeNull()
  })

  it('edits the language of a managed Whisper provider without credentials or endpoints', async () => {
    const api = createMockApi()
    vi.mocked(api.providers.list).mockResolvedValue([
      managedWhisperProfileFixture,
      ...profilesFixture
    ])
    const user = userEvent.setup()
    renderApp(api)
    await screen.findByRole('heading', { name: 'Design sync' })
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    const dialog = await screen.findByRole('dialog', { name: 'Provider settings' })

    expect(
      within(dialog).getByRole('button', {
        name: 'Managed Whisper Large-v3 · large-v3',
        pressed: true
      })
    ).toBeTruthy()
    expect(dialog.querySelector('.provider-form')?.textContent).toContain('Managed Whisper options')
    const language = await within(dialog).findByLabelText('Language code')
    await user.type(language, 'de')
    expect(within(dialog).queryByText('Base URL')).toBeNull()
    expect(within(dialog).queryByText('Secrets')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Save profile' }))

    await waitFor(() => {
      const input = vi.mocked(api.providers.save).mock.calls[0]?.[0]
      expect(input?.profile.kind).toBe('managed-whisper')
      expect(input?.profile.model).toBe('large-v3')
      expect(input?.profile.secretRefs).toEqual({})
      expect(input?.secrets).toEqual({})
      if (input?.profile.kind === 'managed-whisper') expect(input.profile.language).toBe('de')
    })
  })

  it('cancels a pending OBS connection when the connection dialog closes', async () => {
    let rejectConnection!: (error: Error) => void
    let finishCancellation!: () => void
    const onConnect = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectConnection = reject
        })
    )
    const onCancelConnect = vi.fn(() => {
      rejectConnection(new Error('The OBS connection attempt was cancelled'))
      return new Promise<void>((resolve) => {
        finishCancellation = resolve
      })
    })
    function Harness(): React.JSX.Element {
      const [open, setOpen] = React.useState(true)
      const [connected, setConnected] = React.useState(false)
      return React.createElement(ObsConnectionDialog, {
        open,
        connected,
        obsVersion: null,
        onOpenChange: setOpen,
        onConnect: async () => {
          setConnected(true)
          await onConnect()
        },
        onCancelConnect,
        onDisconnect: async () => undefined
      })
    }
    const user = userEvent.setup()
    render(React.createElement(Harness))

    const dialog = await screen.findByRole('dialog', { name: 'OBS connection' })
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }))
    expect(within(dialog).getByRole('status').textContent).toContain('Waiting for OBS Studio')
    expect(within(dialog).queryByRole('button', { name: 'Done' })).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(onCancelConnect).toHaveBeenCalledOnce())
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Connecting...' }).disabled
    ).toBe(true)
    finishCancellation()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'OBS connection' })).toBeNull())
  })

  it('shows the OBS setup error without Electron IPC transport text', async () => {
    const onConnect = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'sessionscribe:invoke': ObsSubsystemError: The OBS WebSocket server is disabled."
      )
    })
    render(
      React.createElement(ObsConnectionDialog, {
        open: true,
        connected: false,
        obsVersion: null,
        onOpenChange: vi.fn(),
        onConnect,
        onCancelConnect: async () => undefined,
        onDisconnect: async () => undefined
      })
    )
    const user = userEvent.setup()
    const dialog = await screen.findByRole('dialog', { name: 'OBS connection' })

    await user.click(within(dialog).getByRole('button', { name: 'Connect' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toBe('The OBS WebSocket server is disabled.')
  })

  it('waits for OBS provisioning before discovering capture sources', async () => {
    const onDiscover = vi.fn(async () => ({ targets: [], audioDevices: [] }))
    const props = {
      session: sessionFixture,
      profiles: profilesFixture,
      onOpenConnection: vi.fn(),
      onDiscover,
      onConfigure: vi.fn(async () => undefined),
      onSelectPortalTarget: vi.fn(async () => undefined),
      onPreflight: vi.fn(async () => ({
        ok: true,
        blockers: [],
        warnings: [],
        screenshotDataUrl: null
      })),
      onStart: vi.fn(async () => undefined),
      onStop: vi.fn(async () => undefined)
    }
    const view = render(
      React.createElement(CaptureWorkspace, {
        ...props,
        status: { ...captureFixture, connected: true, phase: 'configuring' }
      })
    )

    await Promise.resolve()
    expect(onDiscover).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Preparing OBS Studio' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Connect OBS' })).toBeNull()
    view.rerender(
      React.createElement(CaptureWorkspace, {
        ...props,
        status: { ...captureFixture, connected: true, phase: 'ready' }
      })
    )
    await waitFor(() => expect(onDiscover).toHaveBeenCalledOnce())
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

  it('imports media without a summary provider for transcript-only processing', async () => {
    const user = userEvent.setup()
    const onImport = vi.fn(async () => sessionFixture)
    render(
      React.createElement(NewSessionDialog, {
        open: true,
        initialSource: 'import',
        profiles: profilesFixture,
        onOpenChange: vi.fn(),
        onCreate: vi.fn(async () => sessionFixture),
        onImport
      })
    )

    await user.click(screen.getByRole('combobox', { name: 'Summary provider' }))
    await user.click(await screen.findByRole('option', { name: 'No summary — transcript only' }))
    await user.click(screen.getByRole('button', { name: 'Choose media' }))

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith({
        mode: 'meeting',
        transcriptionProfileId: profilesFixture[0]!.id,
        summaryProfileId: null
      })
    )
  })

  it('defaults to transcript-only import when no summary profiles exist', async () => {
    const user = userEvent.setup()
    const onImport = vi.fn(async () => sessionFixture)
    render(
      React.createElement(NewSessionDialog, {
        open: true,
        initialSource: 'import',
        profiles: [profilesFixture[0]!],
        onOpenChange: vi.fn(),
        onCreate: vi.fn(async () => sessionFixture),
        onImport
      })
    )

    expect(screen.getByRole('combobox', { name: 'Summary provider' }).textContent).toContain(
      'No summary — transcript only'
    )
    await user.click(screen.getByRole('button', { name: 'Choose media' }))

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith({
        mode: 'meeting',
        transcriptionProfileId: profilesFixture[0]!.id,
        summaryProfileId: null
      })
    )
  })

  it('starts an OBS recording with transcript-only processing', async () => {
    const user = userEvent.setup()
    const onStart = vi.fn(async () => undefined)
    const onDiscover = vi.fn(async () => ({
      targets: [
        { id: 'target-1', label: 'Game window', platform: 'x11' as const, requiresPortal: false }
      ],
      audioDevices: []
    }))
    render(
      React.createElement(CaptureWorkspace, {
        session: sessionFixture,
        status: { ...captureFixture, connected: true, phase: 'ready' },
        profiles: profilesFixture,
        onOpenConnection: vi.fn(),
        onDiscover,
        onConfigure: vi.fn(async () => undefined),
        onSelectPortalTarget: vi.fn(async () => undefined),
        onPreflight: vi.fn(async () => ({
          ok: true,
          blockers: [],
          warnings: [],
          screenshotDataUrl: null
        })),
        onStart,
        onStop: vi.fn(async () => undefined)
      })
    )

    await waitFor(() => expect(onDiscover).toHaveBeenCalledOnce())
    await user.click(screen.getByRole('combobox', { name: 'Summary provider' }))
    await user.click(await screen.findByRole('option', { name: 'No summary — transcript only' }))
    await user.click(screen.getByRole('button', { name: 'Run preflight' }))
    await screen.findByText('Ready to record')
    await user.click(screen.getByRole('button', { name: 'Start recording' }))

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith({
        sessionId: sessionFixture.id,
        transcriptionProfileId: profilesFixture[0]!.id,
        summaryProfileId: null
      })
    )
  })
})
