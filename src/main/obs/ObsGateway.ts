import { EventEmitter } from 'node:events'

import {
  EventSubscription,
  OBSWebSocket,
  type OBSEventTypes,
  type OBSRequestTypes,
  type OBSResponseTypes
} from 'obs-websocket-js/json'

import { DEFAULT_REQUEST_TIMEOUT_MS, REQUIRED_OBS_REQUESTS } from './constants'
import { ObsSubsystemError, ObsTimeoutError } from './errors'
import type { LoggerLike, ObsConnectionOptions, ObsVersionInfo } from './types'
import { silentLogger } from './types'

type GatewayEvents = {
  connected: []
  disconnected: [error: Error | null]
  volumeMeters: [event: OBSEventTypes['InputVolumeMeters']]
}

function withTimeout<T>(promise: Promise<T>, operation: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ObsTimeoutError(operation, timeoutMs)), timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

function assertLoopbackUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new ObsSubsystemError('OBS_URL_INVALID', 'The OBS websocket URL is invalid', error)
  }

  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new ObsSubsystemError('OBS_URL_INVALID', 'The OBS websocket URL must use ws:// or wss://')
  }

  const hostname = url.hostname.toLowerCase()
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
    throw new ObsSubsystemError(
      'OBS_REMOTE_UNSUPPORTED',
      'Only a local OBS websocket connection is supported'
    )
  }
  if (url.username || url.password) {
    throw new ObsSubsystemError(
      'OBS_URL_INVALID',
      'Credentials must not be embedded in the OBS URL'
    )
  }
  return url.toString().replace(/\/$/, '')
}

export class ObsGateway extends EventEmitter<GatewayEvents> {
  private readonly client: OBSWebSocket
  private connectionOptions: ObsConnectionOptions | null = null
  private info: ObsVersionInfo | null = null

  constructor(
    client: OBSWebSocket = new OBSWebSocket(),
    private readonly logger: LoggerLike = silentLogger
  ) {
    super()
    this.client = client
    this.client.on('ConnectionClosed', (error) => {
      this.info = null
      this.emit('disconnected', error)
    })
    this.client.on('ConnectionError', (error) => {
      this.logger.warn('OBS websocket connection error', { code: error.code })
    })
    this.client.on('InputVolumeMeters', (event) => this.emit('volumeMeters', event))
  }

  get connected(): boolean {
    return this.client.identified && this.info !== null
  }

  get version(): ObsVersionInfo | null {
    return this.info
  }

  get lastConnectionOptions(): ObsConnectionOptions | null {
    return this.connectionOptions ? { ...this.connectionOptions } : null
  }

  async connect(options: ObsConnectionOptions): Promise<ObsVersionInfo> {
    const url = assertLoopbackUrl(options.url)
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    if (this.client.identified) await this.client.disconnect()

    const identified = await withTimeout(
      this.client.connect(url, options.password, {
        rpcVersion: 1,
        eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters
      }),
      'Connecting to OBS',
      timeoutMs
    )

    if (identified.negotiatedRpcVersion !== 1) {
      await this.client.disconnect()
      throw new ObsSubsystemError(
        'OBS_RPC_UNSUPPORTED',
        `OBS negotiated unsupported websocket RPC ${identified.negotiatedRpcVersion}`
      )
    }

    const version = await this.call('GetVersion', undefined, timeoutMs)
    const major = Number.parseInt(version.obsVersion.split('.')[0] ?? '', 10)
    if (!Number.isFinite(major) || major < 32) {
      await this.client.disconnect()
      throw new ObsSubsystemError(
        'OBS_VERSION_UNSUPPORTED',
        'SessionScribe requires OBS Studio 32 or newer'
      )
    }

    const availableRequests = new Set(version.availableRequests)
    const missing = REQUIRED_OBS_REQUESTS.filter((request) => !availableRequests.has(request))
    if (missing.length > 0) {
      await this.client.disconnect()
      throw new ObsSubsystemError(
        'OBS_CAPABILITY_MISSING',
        `OBS is missing required websocket requests: ${missing.join(', ')}`
      )
    }

    this.connectionOptions = { ...options, url }
    this.info = {
      obsVersion: version.obsVersion,
      obsWebSocketVersion: version.obsWebSocketVersion,
      rpcVersion: version.rpcVersion,
      platform: version.platform,
      platformDescription: version.platformDescription,
      availableRequests,
      supportedImageFormats: [...version.supportedImageFormats]
    }
    this.logger.info('Connected to OBS', {
      obsVersion: this.info.obsVersion,
      obsWebSocketVersion: this.info.obsWebSocketVersion,
      platform: this.info.platform
    })
    this.emit('connected')
    return this.info
  }

  async reconnect(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<ObsVersionInfo> {
    if (!this.connectionOptions) {
      throw new ObsSubsystemError('OBS_NOT_CONFIGURED', 'No previous OBS connection is available')
    }
    return this.connect({ ...this.connectionOptions, timeoutMs })
  }

  async disconnect(): Promise<void> {
    this.info = null
    if (this.client.identified) await this.client.disconnect()
  }

  async call<K extends keyof OBSRequestTypes>(
    requestType: K,
    requestData?: OBSRequestTypes[K],
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<OBSResponseTypes[K]> {
    if (!this.client.identified) {
      throw new ObsSubsystemError('OBS_DISCONNECTED', 'OBS is not connected')
    }
    return withTimeout(this.client.call(requestType, requestData), String(requestType), timeoutMs)
  }

  onObsEvent<K extends keyof OBSEventTypes>(
    event: K,
    listener: (payload: OBSEventTypes[K]) => void
  ): () => void {
    this.client.on(event, listener as never)
    return () => this.client.off(event, listener as never)
  }

  waitForObsEvent<K extends keyof OBSEventTypes>(
    event: K,
    predicate: (payload: OBSEventTypes[K]) => boolean,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<OBSEventTypes[K]> {
    return new Promise((resolve, reject) => {
      const listener = (payload: OBSEventTypes[K]): void => {
        if (!predicate(payload)) return
        cleanup()
        resolve(payload)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new ObsTimeoutError(String(event), timeoutMs))
      }, timeoutMs)
      timer.unref?.()
      const cleanup = (): void => {
        clearTimeout(timer)
        this.client.off(event, listener as never)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        cleanup()
        reject(
          new ObsSubsystemError('OBS_WAIT_ABORTED', `Waiting for ${String(event)} was cancelled`)
        )
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.client.on(event, listener as never)
    })
  }
}
