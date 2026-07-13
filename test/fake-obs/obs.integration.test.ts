import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CaptureController } from '../../src/main/app/contracts'
import type { ArtifactProbe } from '../../src/main/obs/ArtifactProbe'
import { ObsCaptureService } from '../../src/main/obs/ObsCaptureService'
import { ObsGateway } from '../../src/main/obs/ObsGateway'
import { FakeObsServer } from './FakeObsServer'

describe('OBS WebSocket v5 integration', () => {
  const servers: FakeObsServer[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map(async (server) => server.close()))
    await Promise.allSettled(
      temporaryDirectories
        .splice(0)
        .map(async (directory) => rm(directory, { recursive: true, force: true }))
    )
  })

  it('authenticates and rejects invalid credentials', async () => {
    const server = await FakeObsServer.start({ password: 'correct horse' })
    servers.push(server)

    const invalidGateway = new ObsGateway()
    await expect(
      invalidGateway.connect({ url: server.url, password: 'wrong battery' })
    ).rejects.toMatchObject({ code: 4009 })

    const gateway = new ObsGateway()
    const version = await gateway.connect({ url: server.url, password: 'correct horse' })
    expect(version.obsVersion).toBe('32.0.1')
    expect(version.rpcVersion).toBe(1)
    await gateway.disconnect()
  })

  it('cancels a connection while OBS resource provisioning is waiting for a response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-cancel-'))
    temporaryDirectories.push(root)
    const server = await FakeObsServer.start()
    server.hangNextResponse('GetProfileList')
    servers.push(server)
    const service = new ObsCaptureService({
      recordingsRoot: join(root, 'recordings'),
      activeManifestPath: join(root, 'active-recording.json'),
      platform: 'windows'
    })
    const abortController = new AbortController()
    const connection = service.connect({
      url: server.url,
      password: 'sessionscribe-test',
      timeoutMs: 5_000,
      deadlineMs: Date.now() + 5_000,
      signal: abortController.signal
    })
    const cancelled = expect(connection).rejects.toMatchObject({ code: 'OBS_CONNECT_CANCELLED' })
    await vi.waitFor(() => {
      expect(server.requestLog.some((request) => request.requestType === 'GetProfileList')).toBe(
        true
      )
    })

    abortController.abort()
    await service.cancelConnect()
    await cancelled
    await expect(service.status()).resolves.toMatchObject({
      connected: false,
      phase: 'disconnected'
    })
  })

  it('cancels a connection that is waiting to apply recovered recording state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-recovery-cancel-'))
    temporaryDirectories.push(root)
    const server = await FakeObsServer.start()
    servers.push(server)
    const service = new ObsCaptureService({
      recordingsRoot: join(root, 'recordings'),
      activeManifestPath: join(root, 'state', 'active-recording.json'),
      platform: 'windows'
    })
    const sessionId = randomUUID()
    const recordDirectory = resolve(root, 'recordings', sessionId)
    const timestamp = new Date().toISOString()
    server.simulateExternalRecording(recordDirectory)
    await service.manifestStore.save({
      version: 1,
      sessionId,
      state: 'recording',
      recordDirectory,
      outputPaths: [],
      profileName: 'SessionScribe',
      sceneCollectionName: 'SessionScribe',
      previousProfileName: 'Default',
      previousSceneCollectionName: 'Default',
      platform: 'windows',
      configuration: {
        targetId: 'window-planning',
        microphoneDeviceId: null,
        outputDeviceId: 'window-audio',
        captureCursor: true
      },
      windowInputUuid: randomUUID(),
      microphoneInputUuid: null,
      systemAudioInputUuid: null,
      startedAt: timestamp,
      stopRequestedAt: null,
      completedAt: null,
      lastDurationMs: 0,
      lastBytes: 0,
      error: null,
      updatedAt: timestamp
    })

    let releaseAdoption!: () => void
    let markAdoptionStarted!: () => void
    const adoptionStarted = new Promise<void>((resolveStarted) => {
      markAdoptionStarted = resolveStarted
    })
    const adoptionGate = new Promise<void>((resolveAdoption) => {
      releaseAdoption = resolveAdoption
    })
    const adoptRestorationLease = service.provisioner.adoptRestorationLease.bind(
      service.provisioner
    )
    vi.spyOn(service.provisioner, 'adoptRestorationLease').mockImplementation(async (manifest) => {
      markAdoptionStarted()
      await adoptionGate
      await adoptRestorationLease(manifest)
    })
    const abortController = new AbortController()
    const connection = service.connect({
      url: server.url,
      password: 'sessionscribe-test',
      signal: abortController.signal
    })
    const cancelled = expect(connection).rejects.toMatchObject({ code: 'OBS_CONNECT_CANCELLED' })
    await adoptionStarted

    abortController.abort()
    await service.cancelConnect()
    releaseAdoption()
    await cancelled

    await expect(service.status()).resolves.toMatchObject({
      connected: false,
      phase: 'disconnected'
    })
    expect(service.gateway.connected).toBe(false)
  })

  it('returns to ready after an OBS capture configuration request fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-configure-failure-'))
    temporaryDirectories.push(root)
    const server = await FakeObsServer.start()
    servers.push(server)
    const service = new ObsCaptureService({
      recordingsRoot: join(root, 'recordings'),
      activeManifestPath: join(root, 'active-recording.json'),
      platform: 'windows'
    })
    await service.connect({ url: server.url, password: 'sessionscribe-test' })
    await service.discover()
    server.failNextResponseAfterMutation('SetInputSettings')

    await expect(
      service.configure({
        targetId: 'window-planning',
        microphoneDeviceId: 'device-default',
        outputDeviceId: 'window-audio',
        captureCursor: true
      })
    ).rejects.toBeTruthy()
    await expect(service.status()).resolves.toMatchObject({ connected: true, phase: 'ready' })
    await service.disconnect()
  })

  it('provisions, configures, records, reconciles a lost stop response, and validates the artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-'))
    temporaryDirectories.push(root)
    const server = await FakeObsServer.start()
    servers.push(server)

    const probe = vi.fn(() =>
      Promise.resolve({
        durationSeconds: 1,
        hasVideo: true,
        hasAudio: true
      })
    )
    const artifactProbe: ArtifactProbe = { probe }
    const service = new ObsCaptureService({
      recordingsRoot: join(root, 'recordings'),
      activeManifestPath: join(root, 'state', 'active-recording.json'),
      scratchDirectory: join(root, 'scratch'),
      platform: 'windows',
      controllerOptions: {
        artifactProbe,
        wait: () => Promise.resolve()
      }
    })
    const captureController: CaptureController = service
    expect(captureController).toBe(service)

    const observedPhases: string[] = []
    const unsubscribe = service.subscribe((status) => observedPhases.push(status.phase))
    const connected = await service.connect({ url: server.url, password: 'sessionscribe-test' })
    expect(connected).toMatchObject({ connected: true, obsVersion: '32.0.1', phase: 'ready' })

    const discovery = await service.discover()
    expect(discovery.targets).toContainEqual({
      id: 'window-planning',
      label: 'Planning - Browser',
      platform: 'windows',
      requiresPortal: false
    })
    expect(discovery.audioDevices).toContainEqual({
      id: 'window-audio',
      label: 'Selected window audio',
      kind: 'window'
    })

    await service.configure({
      targetId: 'window-planning',
      microphoneDeviceId: 'device-default',
      outputDeviceId: 'window-audio',
      captureCursor: true
    })
    const preflight = await service.preflight()
    expect(preflight.ok).toBe(true)
    expect(preflight.screenshotDataUrl).toMatch(/^data:image\/jpeg;base64,/)

    const sessionId = randomUUID()
    const sessionDirectory = join(root, 'recordings', sessionId)
    const recording = await service.start(sessionId, sessionDirectory)
    expect(recording).toMatchObject({ phase: 'recording', activeSessionId: sessionId })

    server.failNextResponseAfterMutation('StopRecord')
    const stopped = await service.stop()
    const expectedOutput = resolve(sessionDirectory, 'recording.mkv')
    expect(stopped.status).toMatchObject({ phase: 'ready', activeSessionId: null })
    expect(stopped.sessionId).toBe(sessionId)
    expect(stopped.outputPath).toBe(expectedOutput)
    expect(stopped.outputPaths).toEqual([expectedOutput])
    expect(stopped.sessionDirectory).toBe(resolve(sessionDirectory))
    expect(stopped.durationMs).not.toBeNull()
    expect(stopped.durationMs ?? 0).toBeGreaterThanOrEqual(1)
    expect(probe).toHaveBeenCalledWith(expectedOutput)

    const requests = server.requestLog.map((request) => request.requestType)
    expect(requests.filter((request) => request === 'StartRecord')).toHaveLength(1)
    expect(requests.filter((request) => request === 'StopRecord')).toHaveLength(1)
    expect(requests).not.toContain('ToggleRecord')
    expect(observedPhases).toContain('recording')
    expect(observedPhases).toContain('finalizing')

    await expect(
      service.start(randomUUID(), join(root, 'recordings', randomUUID()))
    ).rejects.toMatchObject({ code: 'OBS_RECORDING_PENDING_ACKNOWLEDGEMENT' })
    await expect(service.manifestStore.load()).resolves.toMatchObject({ sessionId })

    await service.acknowledgeRecording(sessionId)
    await expect(service.manifestStore.load()).resolves.toBeNull()

    unsubscribe()
    await service.disconnect()
    expect(await service.status()).toMatchObject({ connected: false, phase: 'disconnected' })
  })

  it('checks for an external recording before changing the OBS profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-guard-'))
    temporaryDirectories.push(root)
    const server = await FakeObsServer.start()
    server.simulateExternalRecording(root)
    servers.push(server)
    const service = new ObsCaptureService({
      recordingsRoot: join(root, 'recordings'),
      activeManifestPath: join(root, 'active-recording.json'),
      platform: 'x11'
    })

    await expect(
      service.connect({ url: server.url, password: 'sessionscribe-test' })
    ).rejects.toMatchObject({ code: 'OBS_EXTERNAL_RECORDING_ACTIVE' })
    const requests = server.requestLog.map((request) => request.requestType)
    expect(requests).toEqual(['GetVersion', 'GetRecordStatus'])
    await service.disconnect()
  })

  it('stops automatic recovery reconnect before a manual connection takes ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-manual-reconnect-'))
    temporaryDirectories.push(root)
    const firstServer = await FakeObsServer.start()
    servers.push(firstServer)
    const service = new ObsCaptureService({
      recordingsRoot: join(root, 'recordings'),
      activeManifestPath: join(root, 'active-recording.json'),
      platform: 'windows',
      controllerOptions: { wait: () => Promise.resolve() }
    })
    await service.connect({ url: firstServer.url, password: 'sessionscribe-test' })
    await service.configure({
      targetId: 'window-planning',
      microphoneDeviceId: null,
      outputDeviceId: 'window-audio',
      captureCursor: true
    })
    const sessionId = randomUUID()
    await service.start(sessionId, join(root, 'recordings', sessionId))

    await firstServer.close()
    servers.splice(servers.indexOf(firstServer), 1)
    await vi.waitFor(async () => {
      expect(await service.status()).toMatchObject({ connected: false, phase: 'recovering' })
    })

    const replacementServer = await FakeObsServer.start()
    servers.push(replacementServer)
    await expect(
      service.connect({ url: replacementServer.url, password: 'sessionscribe-test' })
    ).resolves.toMatchObject({ connected: true, phase: 'ready', activeSessionId: null })
    expect(replacementServer.requestLog.map((request) => request.requestType)).toContain(
      'GetVersion'
    )

    await service.acknowledgeRecording(sessionId)
    await service.disconnect()
  })

  it('hands off a pre-start manifest as failed and blocks replacement until acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-pending-'))
    temporaryDirectories.push(root)
    const server = await FakeObsServer.start()
    servers.push(server)
    const service = new ObsCaptureService({
      recordingsRoot: join(root, 'recordings'),
      activeManifestPath: join(root, 'active-recording.json'),
      platform: 'windows'
    })
    const pendingSessionId = randomUUID()
    const timestamp = new Date().toISOString()
    await service.manifestStore.save({
      version: 1,
      sessionId: pendingSessionId,
      state: 'ready',
      recordDirectory: resolve(root, 'recordings', pendingSessionId),
      outputPaths: [],
      profileName: 'SessionScribe',
      sceneCollectionName: 'SessionScribe',
      previousProfileName: 'Default',
      previousSceneCollectionName: 'Default',
      platform: 'windows',
      configuration: {
        targetId: 'window-planning',
        microphoneDeviceId: null,
        outputDeviceId: 'window-audio',
        captureCursor: true
      },
      windowInputUuid: randomUUID(),
      microphoneInputUuid: null,
      systemAudioInputUuid: null,
      startedAt: null,
      stopRequestedAt: null,
      completedAt: null,
      lastDurationMs: 0,
      lastBytes: 0,
      error: null,
      updatedAt: timestamp
    })
    const recoveryActions: string[] = []
    service.on('recovery', (result) => recoveryActions.push(result.action))
    await service.connect({ url: server.url, password: 'sessionscribe-test' })
    expect(recoveryActions).toEqual(['failed'])
    await expect(service.manifestStore.load()).resolves.toMatchObject({
      sessionId: pendingSessionId,
      state: 'failed',
      error: 'The application stopped before OBS was asked to start recording.'
    })
    expect(service.controller.currentManifest).toMatchObject({
      sessionId: pendingSessionId,
      state: 'failed'
    })
    await service.configure({
      targetId: 'window-planning',
      microphoneDeviceId: null,
      outputDeviceId: 'window-audio',
      captureCursor: true
    })

    recoveryActions.length = 0
    await expect(
      service.start(randomUUID(), join(root, 'recordings', randomUUID()))
    ).rejects.toMatchObject({ code: 'OBS_RECORDING_PENDING_ACKNOWLEDGEMENT' })
    expect(recoveryActions).toEqual(['failed'])
    await expect(service.manifestStore.load()).resolves.toMatchObject({
      sessionId: pendingSessionId
    })

    await service.acknowledgeRecording(pendingSessionId)
    await service.disconnect()
  })

  it('reopens the Wayland portal only while OBS is connected and idle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-wayland-'))
    temporaryDirectories.push(root)
    const server = await FakeObsServer.start()
    servers.push(server)
    const service = new ObsCaptureService({
      recordingsRoot: join(root, 'recordings'),
      activeManifestPath: join(root, 'active-recording.json'),
      platform: 'wayland'
    })

    await service.connect({ url: server.url, password: 'sessionscribe-test' })
    await service.discover()
    await service.selectPortalTarget()

    const createRequests = server.requestLog.filter(
      (request) => request.requestType === 'CreateInput'
    )
    expect(createRequests).toContainEqual(
      expect.objectContaining({
        requestData: expect.objectContaining({
          inputKind: 'pipewire-screen-capture-source'
        })
      })
    )
    const portalRequests = server.requestLog.filter(
      (request) => request.requestType === 'PressInputPropertiesButton'
    )
    expect(portalRequests).toHaveLength(1)
    expect(portalRequests[0]?.requestData).toMatchObject({ propertyName: 'Reload' })

    server.simulateExternalRecording(root)
    await expect(service.selectPortalTarget()).rejects.toMatchObject({
      code: 'OBS_EXTERNAL_RECORDING_ACTIVE'
    })
    expect(
      server.requestLog.filter((request) => request.requestType === 'PressInputPropertiesButton')
    ).toHaveLength(1)
  })

  it('keeps the restoration lease after acknowledgement and respects newer user selections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-lease-'))
    temporaryDirectories.push(root)
    const server = await FakeObsServer.start()
    servers.push(server)
    const serviceOptions = {
      recordingsRoot: join(root, 'recordings'),
      activeManifestPath: join(root, 'state', 'active-recording.json'),
      resourceLeasePath: join(root, 'state', 'obs-resource-restoration.json'),
      platform: 'windows' as const,
      controllerOptions: {
        artifactProbe: {
          probe: vi.fn(() =>
            Promise.resolve({ durationSeconds: 1, hasVideo: true, hasAudio: true })
          )
        },
        wait: () => Promise.resolve()
      }
    }
    const firstProcess = new ObsCaptureService(serviceOptions)
    await firstProcess.connect({ url: server.url, password: 'sessionscribe-test' })
    await firstProcess.configure({
      targetId: 'window-planning',
      microphoneDeviceId: 'device-default',
      outputDeviceId: 'window-audio',
      captureCursor: true
    })
    const sessionId = randomUUID()
    await firstProcess.start(sessionId, join(root, 'recordings', sessionId))
    await firstProcess.stop()
    await firstProcess.acknowledgeRecording(sessionId)

    await expect(firstProcess.manifestStore.load()).resolves.toBeNull()
    await expect(firstProcess.resourceLeaseStore.load()).resolves.toMatchObject({
      managedProfileName: 'SessionScribe',
      managedSceneCollectionName: 'SessionScribe',
      previousProfileName: 'Default',
      previousSceneCollectionName: 'Default'
    })

    await firstProcess.gateway.disconnect()
    server.simulateUserResourceSelection('Streaming', 'Live scenes')
    const secondProcess = new ObsCaptureService(serviceOptions)
    await secondProcess.connect({ url: server.url, password: 'sessionscribe-test' })
    await expect(secondProcess.resourceLeaseStore.load()).resolves.toMatchObject({
      previousProfileName: 'Streaming',
      previousSceneCollectionName: 'Live scenes'
    })
    await secondProcess.disconnect()

    expect(server.currentProfileName).toBe('Streaming')
    expect(server.currentSceneCollectionName).toBe('Live scenes')
    await expect(secondProcess.resourceLeaseStore.load()).resolves.toBeNull()
  })

  it('emits recovered media from disk, start reconciliation, and automatic reconnect exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-recovery-events-'))
    temporaryDirectories.push(root)
    const server = await FakeObsServer.start()
    servers.push(server)
    const serviceOptions = {
      recordingsRoot: join(root, 'recordings'),
      activeManifestPath: join(root, 'state', 'active-recording.json'),
      resourceLeasePath: join(root, 'state', 'obs-resource-restoration.json'),
      platform: 'windows' as const,
      controllerOptions: {
        artifactProbe: {
          probe: vi.fn(() =>
            Promise.resolve({ durationSeconds: 1, hasVideo: true, hasAudio: true })
          )
        },
        wait: () => Promise.resolve()
      }
    }
    const firstProcess = new ObsCaptureService(serviceOptions)
    await firstProcess.connect({ url: server.url, password: 'sessionscribe-test' })
    await firstProcess.configure({
      targetId: 'window-planning',
      microphoneDeviceId: 'device-default',
      outputDeviceId: 'window-audio',
      captureCursor: true
    })
    const recoveredSessionId = randomUUID()
    await firstProcess.start(recoveredSessionId, join(root, 'recordings', recoveredSessionId))
    await firstProcess.stop()
    await firstProcess.gateway.disconnect()

    const recoveredProcess = new ObsCaptureService(serviceOptions)
    const recoveryActions: string[] = []
    recoveredProcess.on('recovery', (result) => recoveryActions.push(result.action))
    await recoveredProcess.connect({ url: server.url, password: 'sessionscribe-test' })
    expect(recoveryActions).toEqual(['finalized'])
    await recoveredProcess.configure({
      targetId: 'window-planning',
      microphoneDeviceId: 'device-default',
      outputDeviceId: 'window-audio',
      captureCursor: true
    })

    recoveryActions.length = 0
    await expect(
      recoveredProcess.start(randomUUID(), join(root, 'recordings', randomUUID()))
    ).rejects.toMatchObject({ code: 'OBS_RECORDING_PENDING_ACKNOWLEDGEMENT' })
    expect(recoveryActions).toEqual(['finalized'])

    recoveryActions.length = 0
    await (
      recoveredProcess as unknown as { reconnectActiveSession(): Promise<void> }
    ).reconnectActiveSession()
    expect(recoveryActions).toEqual(['finalized'])
    await expect(recoveredProcess.manifestStore.load()).resolves.toMatchObject({
      sessionId: recoveredSessionId
    })

    await recoveredProcess.acknowledgeRecording(recoveredSessionId)
    await recoveredProcess.disconnect()
  })

  it('retains an interrupted manifest when recovered media cannot yet be validated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-recovery-retry-'))
    temporaryDirectories.push(root)
    const server = await FakeObsServer.start()
    servers.push(server)
    const paths = {
      recordingsRoot: join(root, 'recordings'),
      activeManifestPath: join(root, 'state', 'active-recording.json'),
      resourceLeasePath: join(root, 'state', 'obs-resource-restoration.json')
    }
    const firstProcess = new ObsCaptureService({
      ...paths,
      platform: 'windows',
      controllerOptions: {
        artifactProbe: {
          probe: vi.fn(() =>
            Promise.resolve({ durationSeconds: 1, hasVideo: true, hasAudio: true })
          )
        },
        wait: () => Promise.resolve()
      }
    })
    await firstProcess.connect({ url: server.url, password: 'sessionscribe-test' })
    await firstProcess.configure({
      targetId: 'window-planning',
      microphoneDeviceId: null,
      outputDeviceId: 'window-audio',
      captureCursor: true
    })
    const sessionId = randomUUID()
    await firstProcess.start(sessionId, join(paths.recordingsRoot, sessionId))
    await firstProcess.stop()
    await firstProcess.gateway.disconnect()

    const recoveryResults: Array<{ action: string; artifactCount: number }> = []
    const retryProcess = new ObsCaptureService({
      ...paths,
      platform: 'windows',
      controllerOptions: {
        artifactProbe: {
          probe: vi.fn(() => Promise.reject(new Error('ffprobe is temporarily unavailable')))
        },
        wait: () => Promise.resolve()
      }
    })
    retryProcess.on('recovery', (result) =>
      recoveryResults.push({ action: result.action, artifactCount: result.artifacts.length })
    )
    await retryProcess.connect({ url: server.url, password: 'sessionscribe-test' })

    expect(recoveryResults).toEqual([{ action: 'interrupted', artifactCount: 0 }])
    await expect(retryProcess.manifestStore.load()).resolves.toMatchObject({
      sessionId,
      state: 'interrupted',
      error: 'ffprobe is temporarily unavailable'
    })
    await retryProcess.acknowledgeRecording(sessionId)
    await retryProcess.disconnect()
  })

  it('persists the restoration lease before provisioning and retains it after an unverified restore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-lease-failure-'))
    temporaryDirectories.push(root)
    const server = await FakeObsServer.start()
    servers.push(server)
    const serviceOptions = {
      recordingsRoot: join(root, 'recordings'),
      activeManifestPath: join(root, 'active-recording.json'),
      resourceLeasePath: join(root, 'obs-resource-restoration.json'),
      platform: 'x11' as const
    }
    const interruptedProvision = new ObsCaptureService(serviceOptions)
    server.failNextResponseAfterMutation('CreateProfile')

    await expect(
      interruptedProvision.connect({ url: server.url, password: 'sessionscribe-test' })
    ).rejects.toThrow('Injected response failure')
    expect(server.currentProfileName).toBe('SessionScribe')
    await expect(interruptedProvision.resourceLeaseStore.load()).resolves.toMatchObject({
      previousProfileName: 'Default',
      previousSceneCollectionName: 'Default'
    })

    await interruptedProvision.gateway.disconnect()
    const unverifiedRestore = new ObsCaptureService(serviceOptions)
    await unverifiedRestore.connect({ url: server.url, password: 'sessionscribe-test' })
    server.failNextResponseAfterMutation('SetCurrentSceneCollection')
    await unverifiedRestore.disconnect()
    await expect(unverifiedRestore.resourceLeaseStore.load()).resolves.not.toBeNull()

    const retry = new ObsCaptureService(serviceOptions)
    await retry.connect({ url: server.url, password: 'sessionscribe-test' })
    await retry.disconnect()
    expect(server.currentProfileName).toBe('Default')
    expect(server.currentSceneCollectionName).toBe('Default')
    await expect(retry.resourceLeaseStore.load()).resolves.toBeNull()
  })
})
