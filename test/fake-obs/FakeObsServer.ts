import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { WebSocket, WebSocketServer, type RawData } from 'ws'

import { REQUIRED_OBS_REQUESTS } from '../../src/main/obs/constants'

type JsonRecord = Record<string, unknown>

interface FakeInput {
  name: string
  uuid: string
  kind: string
  settings: JsonRecord
  muted: boolean
  audioTracks: JsonRecord
  sceneItemId: number
  enabled: boolean
}

export interface FakeObsServerOptions {
  password?: string | null
  obsVersion?: string
  recordingFixturePath?: string
  startEventDelayMs?: number
  stopEventDelayMs?: number
  availableRequests?: readonly string[]
}

export interface FakeObsRequest {
  requestType: string
  requestData: JsonRecord
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {}
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`Missing ${key}`)
  return value
}

function authenticationHash(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256')
    .update(password + salt)
    .digest('base64')
  return createHash('sha256')
    .update(secret + challenge)
    .digest('base64')
}

export class FakeObsServer {
  readonly requestLog: FakeObsRequest[] = []
  readonly url: string

  private readonly server: WebSocketServer
  private readonly identifiedSockets = new Set<WebSocket>()
  private readonly failAfterMutation = new Set<string>()
  private readonly hangBeforeResponse = new Set<string>()
  private readonly options: Required<
    Omit<FakeObsServerOptions, 'recordingFixturePath' | 'availableRequests'>
  > &
    Pick<FakeObsServerOptions, 'recordingFixturePath'> & {
      availableRequests: readonly string[]
    }
  private readonly profileParameters = new Map<string, string>()
  private readonly inputs = new Map<string, FakeInput>()
  private profiles = ['Default']
  private currentProfile = 'Default'
  private sceneCollections = ['Default']
  private currentSceneCollection = 'Default'
  private scenes = ['Scene']
  private currentScene = 'Scene'
  private videoSettings = {
    baseWidth: 1920,
    baseHeight: 1080,
    outputWidth: 1920,
    outputHeight: 1080,
    fpsNumerator: 60,
    fpsDenominator: 1
  }
  private recordDirectory = process.cwd()
  private outputActive = false
  private outputPaused = false
  private outputPath: string | null = null
  private recordingStartedAt = 0
  private nextSceneItemId = 1

  get currentProfileName(): string {
    return this.currentProfile
  }

  get currentSceneCollectionName(): string {
    return this.currentSceneCollection
  }

  private constructor(server: WebSocketServer, port: number, options: FakeObsServerOptions) {
    this.server = server
    this.url = `ws://127.0.0.1:${port}`
    this.options = {
      password: options.password === undefined ? 'sessionscribe-test' : options.password,
      obsVersion: options.obsVersion ?? '32.0.1',
      startEventDelayMs: options.startEventDelayMs ?? 5,
      stopEventDelayMs: options.stopEventDelayMs ?? 5,
      availableRequests: options.availableRequests ?? REQUIRED_OBS_REQUESTS,
      ...(options.recordingFixturePath === undefined
        ? {}
        : { recordingFixturePath: options.recordingFixturePath })
    }
    this.server.on('connection', (socket) => this.accept(socket))
  }

  static async start(options: FakeObsServerOptions = {}): Promise<FakeObsServer> {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      handleProtocols: (protocols) =>
        protocols.has('obswebsocket.json') ? 'obswebsocket.json' : false
    })
    await new Promise<void>((resolveReady, reject) => {
      server.once('listening', resolveReady)
      server.once('error', reject)
    })
    const address = server.address()
    if (typeof address === 'string' || address === null) {
      await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()))
      throw new Error('Fake OBS did not bind a TCP port')
    }
    return new FakeObsServer(server, address.port, options)
  }

  failNextResponseAfterMutation(requestType: string): void {
    this.failAfterMutation.add(requestType)
  }

  hangNextResponse(requestType: string): void {
    this.hangBeforeResponse.add(requestType)
  }

  simulateExternalRecording(recordDirectory = process.cwd()): void {
    this.recordDirectory = recordDirectory
    this.outputActive = true
    this.recordingStartedAt = Date.now()
    this.outputPath = join(recordDirectory, 'external-recording.mkv')
  }

  simulateUserResourceSelection(profileName: string, sceneCollectionName: string): void {
    if (!this.profiles.includes(profileName)) this.profiles.push(profileName)
    if (!this.sceneCollections.includes(sceneCollectionName)) {
      this.sceneCollections.push(sceneCollectionName)
    }
    this.currentProfile = profileName
    this.currentSceneCollection = sceneCollectionName
  }

  emitVolumeMeters(inputs: readonly JsonRecord[]): void {
    this.emitEvent('InputVolumeMeters', { inputs }, 65_536)
  }

  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate()
    await new Promise<void>((resolveClosed, reject) => {
      this.server.close((error) => (error ? reject(error) : resolveClosed()))
    })
  }

  private accept(socket: WebSocket): void {
    const salt = Buffer.from('sessionscribe-salt').toString('base64')
    const challenge = Buffer.from('sessionscribe-challenge').toString('base64')
    const authentication =
      this.options.password === null ? {} : { authentication: { salt, challenge } }
    this.send(socket, 0, {
      obsWebSocketVersion: '5.5.0',
      rpcVersion: 1,
      ...authentication
    })

    socket.on('message', (raw) => {
      void this.handleMessage(socket, raw, salt, challenge).catch(() => {
        socket.close(4002, 'Invalid message')
      })
    })
    socket.on('close', () => this.identifiedSockets.delete(socket))
  }

  private async handleMessage(
    socket: WebSocket,
    raw: RawData,
    salt: string,
    challenge: string
  ): Promise<void> {
    const serialized = Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Buffer.from(new Uint8Array(raw)).toString('utf8')
    const message = asRecord(JSON.parse(serialized) as unknown)
    const op = message.op
    const data = asRecord(message.d)
    if (op === 1) {
      const expected =
        this.options.password === null
          ? undefined
          : authenticationHash(this.options.password, salt, challenge)
      if (expected !== undefined && data.authentication !== expected) {
        socket.close(4009, 'Authentication failed')
        return
      }
      this.identifiedSockets.add(socket)
      this.send(socket, 2, { negotiatedRpcVersion: 1 })
      return
    }
    if (op !== 6 || !this.identifiedSockets.has(socket)) return

    const requestType = requiredString(data, 'requestType')
    const requestId = requiredString(data, 'requestId')
    const requestData = asRecord(data.requestData)
    this.requestLog.push({ requestType, requestData })
    if (this.hangBeforeResponse.delete(requestType)) return
    try {
      const responseData = await this.dispatch(requestType, requestData)
      if (this.failAfterMutation.delete(requestType)) {
        this.respondError(socket, requestType, requestId, 500, 'Injected response failure')
      } else {
        this.send(socket, 7, {
          requestType,
          requestId,
          requestStatus: { result: true, code: 100 },
          responseData
        })
      }
    } catch (error) {
      this.respondError(
        socket,
        requestType,
        requestId,
        500,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private async dispatch(requestType: string, data: JsonRecord): Promise<JsonRecord> {
    switch (requestType) {
      case 'GetVersion':
        return {
          obsVersion: this.options.obsVersion,
          obsWebSocketVersion: '5.5.0',
          rpcVersion: 1,
          availableRequests: [...this.options.availableRequests],
          supportedImageFormats: ['jpeg', 'png'],
          platform: 'linux',
          platformDescription: 'Fake OBS Studio'
        }
      case 'GetProfileList':
        return { currentProfileName: this.currentProfile, profiles: [...this.profiles] }
      case 'SetCurrentProfile':
        this.currentProfile = requiredString(data, 'profileName')
        return {}
      case 'CreateProfile': {
        const profileName = requiredString(data, 'profileName')
        if (!this.profiles.includes(profileName)) this.profiles.push(profileName)
        this.currentProfile = profileName
        return {}
      }
      case 'SetProfileParameter':
        this.profileParameters.set(
          `${requiredString(data, 'parameterCategory')}/${requiredString(data, 'parameterName')}`,
          requiredString(data, 'parameterValue')
        )
        return {}
      case 'GetProfileParameter': {
        const key = `${requiredString(data, 'parameterCategory')}/${requiredString(data, 'parameterName')}`
        return {
          parameterValue: this.profileParameters.get(key) ?? '',
          defaultParameterValue: ''
        }
      }
      case 'GetSceneCollectionList':
        return {
          currentSceneCollectionName: this.currentSceneCollection,
          sceneCollections: [...this.sceneCollections]
        }
      case 'SetCurrentSceneCollection':
        this.currentSceneCollection = requiredString(data, 'sceneCollectionName')
        return {}
      case 'CreateSceneCollection': {
        const name = requiredString(data, 'sceneCollectionName')
        if (!this.sceneCollections.includes(name)) this.sceneCollections.push(name)
        this.currentSceneCollection = name
        this.scenes = []
        this.currentScene = ''
        return {}
      }
      case 'GetSceneList':
        return {
          currentProgramSceneName: this.currentScene,
          currentPreviewSceneName: null,
          scenes: this.scenes.map((sceneName, sceneIndex) => ({
            sceneName,
            sceneUuid: `scene-${sceneName}`,
            sceneIndex
          }))
        }
      case 'GetCurrentProgramScene':
        return {
          currentProgramSceneName: this.currentScene,
          currentProgramSceneUuid: `scene-${this.currentScene}`
        }
      case 'CreateScene': {
        const sceneName = requiredString(data, 'sceneName')
        if (!this.scenes.includes(sceneName)) this.scenes.push(sceneName)
        if (!this.currentScene) this.currentScene = sceneName
        return { sceneUuid: `scene-${sceneName}` }
      }
      case 'SetCurrentProgramScene':
        this.currentScene = requiredString(data, 'sceneName')
        return {}
      case 'GetInputKindList':
        return {
          inputKinds: [
            'window_capture',
            'wasapi_input_capture',
            'wasapi_output_capture',
            'xcomposite_input',
            'pulse_input_capture',
            'pulse_output_capture',
            'pipewire-screen-capture-source'
          ]
        }
      case 'GetInputList':
        return {
          inputs: [...this.inputs.values()].map((input) => ({
            inputName: input.name,
            inputUuid: input.uuid,
            inputKind: input.kind,
            unversionedInputKind: input.kind,
            inputKindCaps: 0
          }))
        }
      case 'CreateInput': {
        const input: FakeInput = {
          name: requiredString(data, 'inputName'),
          uuid: randomUUID(),
          kind: requiredString(data, 'inputKind'),
          settings: asRecord(data.inputSettings),
          muted: false,
          audioTracks: {},
          sceneItemId: this.nextSceneItemId++,
          enabled: data.sceneItemEnabled === true
        }
        this.inputs.set(input.uuid, input)
        return { inputUuid: input.uuid, sceneItemId: input.sceneItemId }
      }
      case 'RemoveInput': {
        const input = this.findInput(data)
        this.inputs.delete(input.uuid)
        return {}
      }
      case 'GetInputSettings': {
        const input = this.findInput(data)
        return { inputSettings: { ...input.settings }, inputKind: input.kind }
      }
      case 'SetInputSettings': {
        const input = this.findInput(data)
        const settings = asRecord(data.inputSettings)
        input.settings = data.overlay === true ? { ...input.settings, ...settings } : settings
        return {}
      }
      case 'GetInputPropertiesListPropertyItems': {
        const propertyName = requiredString(data, 'propertyName')
        if (propertyName === 'device_id') {
          return {
            propertyItems: [
              { itemName: 'Built-in device', itemEnabled: true, itemValue: 'device-default' },
              { itemName: 'Disabled device', itemEnabled: false, itemValue: 'device-disabled' }
            ]
          }
        }
        return {
          propertyItems: [
            { itemName: 'Planning - Browser', itemEnabled: true, itemValue: 'window-planning' },
            { itemName: 'Terminal', itemEnabled: true, itemValue: 'window-terminal' }
          ]
        }
      }
      case 'PressInputPropertiesButton':
        return {}
      case 'GetSpecialInputs':
        return {
          desktop1: 'Desktop Audio',
          desktop2: null,
          mic1: 'Mic/Aux',
          mic2: null,
          mic3: null,
          mic4: null
        }
      case 'GetInputMute':
        return { inputMuted: this.findInput(data).muted }
      case 'SetInputMute': {
        const input = this.tryFindInput(data)
        if (input) input.muted = data.inputMuted === true
        return {}
      }
      case 'SetInputAudioTracks':
        this.findInput(data).audioTracks = asRecord(data.inputAudioTracks)
        return {}
      case 'GetSceneItemId': {
        const input = this.findInput({ inputName: data.sourceName })
        return { sceneItemId: input.sceneItemId }
      }
      case 'SetSceneItemEnabled': {
        const id = data.sceneItemId
        const input = [...this.inputs.values()].find((candidate) => candidate.sceneItemId === id)
        if (!input) throw new Error('Scene item not found')
        input.enabled = data.sceneItemEnabled === true
        return {}
      }
      case 'SetSceneItemTransform':
        return {}
      case 'GetSourceActive':
        this.findInput(data)
        return { videoActive: true, videoShowing: true }
      case 'GetSourceScreenshot':
        this.findInput(data)
        return { imageData: `data:image/jpeg;base64,${'A'.repeat(512)}` }
      case 'SetVideoSettings':
        this.videoSettings = {
          baseWidth: Number(data.baseWidth),
          baseHeight: Number(data.baseHeight),
          outputWidth: Number(data.outputWidth),
          outputHeight: Number(data.outputHeight),
          fpsNumerator: Number(data.fpsNumerator),
          fpsDenominator: Number(data.fpsDenominator)
        }
        return {}
      case 'GetVideoSettings':
        return { ...this.videoSettings }
      case 'SetRecordDirectory':
        this.recordDirectory = requiredString(data, 'recordDirectory')
        return {}
      case 'GetRecordDirectory':
        return { recordDirectory: this.recordDirectory }
      case 'GetStats':
        return {
          cpuUsage: 4,
          memoryUsage: 256,
          availableDiskSpace: 50_000,
          activeFps: 30,
          averageFrameRenderTime: 2,
          renderSkippedFrames: 0,
          renderTotalFrames: 1_000,
          outputSkippedFrames: 0,
          outputTotalFrames: 1_000,
          webSocketSessionIncomingMessages: this.requestLog.length,
          webSocketSessionOutgoingMessages: this.requestLog.length
        }
      case 'GetRecordStatus':
        return this.recordStatus()
      case 'StartRecord':
        if (this.outputActive) throw new Error('Recording is already active')
        this.outputActive = true
        this.recordingStartedAt = Date.now()
        this.outputPath = join(this.recordDirectory, 'recording.mkv')
        setTimeout(() => {
          this.emitEvent(
            'RecordStateChanged',
            {
              outputActive: true,
              outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
              outputPath: this.outputPath
            },
            64
          )
        }, this.options.startEventDelayMs).unref?.()
        return {}
      case 'StopRecord': {
        if (!this.outputActive || !this.outputPath) throw new Error('Recording is not active')
        const completedPath = this.outputPath
        await this.materializeRecording(completedPath)
        this.outputActive = false
        setTimeout(() => {
          this.emitEvent(
            'RecordStateChanged',
            {
              outputActive: false,
              outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
              outputPath: completedPath
            },
            64
          )
        }, this.options.stopEventDelayMs).unref?.()
        return { outputPath: completedPath }
      }
      default:
        throw new Error(`Unhandled fake OBS request: ${requestType}`)
    }
  }

  private recordStatus(): JsonRecord {
    const duration =
      this.recordingStartedAt === 0 ? 0 : Math.max(1, Date.now() - this.recordingStartedAt)
    return {
      outputActive: this.outputActive,
      outputPaused: this.outputPaused,
      outputTimecode: '00:00:00.001',
      outputDuration: duration,
      outputBytes: this.outputActive ? Math.max(1_024, duration * 50) : 0
    }
  }

  private tryFindInput(data: JsonRecord): FakeInput | null {
    const uuid =
      typeof data.inputUuid === 'string'
        ? data.inputUuid
        : typeof data.sourceUuid === 'string'
          ? data.sourceUuid
          : null
    if (uuid) return this.inputs.get(uuid) ?? null
    const name =
      typeof data.inputName === 'string'
        ? data.inputName
        : typeof data.sourceName === 'string'
          ? data.sourceName
          : null
    return name ? ([...this.inputs.values()].find((input) => input.name === name) ?? null) : null
  }

  private findInput(data: JsonRecord): FakeInput {
    const input = this.tryFindInput(data)
    if (!input) throw new Error('Input not found')
    return input
  }

  private async materializeRecording(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    if (this.options.recordingFixturePath) {
      await copyFile(this.options.recordingFixturePath, path)
    } else {
      await writeFile(path, Buffer.from('fake-matroska-recording'))
    }
  }

  private emitEvent(eventType: string, eventData: JsonRecord, eventIntent: number): void {
    for (const socket of this.identifiedSockets) {
      this.send(socket, 5, { eventType, eventIntent, eventData })
    }
  }

  private respondError(
    socket: WebSocket,
    requestType: string,
    requestId: string,
    code: number,
    comment: string
  ): void {
    this.send(socket, 7, {
      requestType,
      requestId,
      requestStatus: { result: false, code, comment }
    })
  }

  private send(socket: WebSocket, op: number, data: JsonRecord): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op, d: data }))
  }
}
