import type {
  AudioDevice,
  CaptureConfiguration,
  CaptureStatus,
  CaptureTarget,
  PreflightResult
} from '@shared/index'
import type { CaptureController } from '../app/contracts'
import {
  isObsConnectionUnavailable,
  ObsDiscovery,
  ObsSubsystemError,
  type LoggerLike,
  type ObsWebSocketSettings
} from '../obs/index'
import type { ObsCaptureService } from '../obs/index'

type ConnectionDiscovery = Pick<ObsDiscovery, 'locate' | 'launch' | 'readWebSocketSettings'>

export interface LaunchableObsCaptureControllerOptions {
  discovery?: ConnectionDiscovery
  logger?: LoggerLike
  initialConnectTimeoutMs?: number
  launchTimeoutMs?: number
  retryConnectTimeoutMs?: number
  retryIntervalMs?: number
  now?: () => number
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export class LaunchableObsCaptureController implements CaptureController {
  private readonly discovery: ConnectionDiscovery
  private readonly logger: LoggerLike | undefined
  private readonly initialConnectTimeoutMs: number
  private readonly launchTimeoutMs: number
  private readonly retryConnectTimeoutMs: number
  private readonly retryIntervalMs: number
  private readonly now: () => number
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private activeConnect: Promise<CaptureStatus> | null = null
  private activeConnectAbort: AbortController | null = null

  constructor(
    private readonly service: ObsCaptureService,
    options: LaunchableObsCaptureControllerOptions = {}
  ) {
    this.discovery =
      options.discovery ?? new ObsDiscovery(service.gateway, undefined, options.logger)
    this.logger = options.logger
    this.initialConnectTimeoutMs = options.initialConnectTimeoutMs ?? 5_000
    this.launchTimeoutMs = options.launchTimeoutMs ?? 20_000
    this.retryConnectTimeoutMs = options.retryConnectTimeoutMs ?? 2_000
    this.retryIntervalMs = options.retryIntervalMs ?? 750
    this.now = options.now ?? Date.now
    this.wait = options.wait ?? waitForRetry
  }

  async connect(input: { url: string; password: string }): Promise<CaptureStatus> {
    if (this.activeConnect) {
      throw new ObsSubsystemError(
        'OBS_CONNECT_IN_PROGRESS',
        'An OBS connection attempt is already in progress'
      )
    }

    const abortController = new AbortController()
    const attempt = this.connectOrLaunch(input, abortController.signal)
    this.activeConnect = attempt
    this.activeConnectAbort = abortController
    try {
      return await attempt
    } finally {
      if (this.activeConnect === attempt) {
        this.activeConnect = null
        this.activeConnectAbort = null
      }
    }
  }

  async cancelConnect(): Promise<void> {
    if (!this.activeConnectAbort) return
    this.activeConnectAbort.abort()
    await this.service.cancelConnect()
  }

  private async connectOrLaunch(
    input: { url: string; password: string },
    signal: AbortSignal
  ): Promise<CaptureStatus> {
    try {
      return await this.service.connect({
        ...input,
        signal,
        timeoutMs: this.initialConnectTimeoutMs,
        deadlineMs: this.now() + this.launchTimeoutMs
      })
    } catch (initialError) {
      this.throwIfCancelled(signal)
      if (!isObsConnectionUnavailable(initialError) || this.service.gateway.connected) {
        throw initialError
      }

      const executable = await this.discovery.locate()
      this.throwIfCancelled(signal)
      const settings = await this.discovery.readWebSocketSettings(executable)
      this.throwIfCancelled(signal)
      this.assertUsableSettings(input.url, settings)
      if (!executable) throw initialError

      await this.discovery.launch(executable)
      this.throwIfCancelled(signal)
      const deadline = this.now() + this.launchTimeoutMs
      let lastError: unknown = initialError

      while (this.now() < deadline) {
        await this.wait(Math.min(this.retryIntervalMs, deadline - this.now()), signal)
        this.throwIfCancelled(signal)
        const remainingMs = deadline - this.now()
        if (remainingMs <= 0) break
        try {
          return await this.service.connect({
            ...input,
            signal,
            timeoutMs: Math.max(1, Math.min(this.retryConnectTimeoutMs, remainingMs)),
            deadlineMs: deadline
          })
        } catch (error) {
          this.throwIfCancelled(signal)
          if (!isObsConnectionUnavailable(error) || this.service.gateway.connected) throw error
          lastError = error
        }
      }

      throw new ObsSubsystemError(
        'OBS_LAUNCH_TIMEOUT',
        `OBS opened, but its WebSocket server is not reachable at ${input.url}. Open Tools > WebSocket Server Settings in OBS, enable the server, verify the port, and try again.`,
        lastError
      )
    }
  }

  private assertUsableSettings(url: string, settings: ObsWebSocketSettings | null): void {
    if (!settings) return
    if (!settings.enabled) {
      this.logger?.warn('OBS WebSocket server is disabled')
      throw new ObsSubsystemError(
        'OBS_WEBSOCKET_DISABLED',
        'The OBS WebSocket server is disabled. Open OBS Studio, choose Tools > WebSocket Server Settings, enable "Enable WebSocket server", click Apply, and connect again.'
      )
    }

    const requested = new URL(url)
    const requestedPort = Number(requested.port || (requested.protocol === 'wss:' ? '443' : '80'))
    if (settings.port !== null && requestedPort !== settings.port) {
      throw new ObsSubsystemError(
        'OBS_WEBSOCKET_PORT_MISMATCH',
        `OBS is configured for WebSocket port ${settings.port}, but SessionScribe is trying port ${requestedPort}. Use ws://127.0.0.1:${settings.port} and connect again.`
      )
    }
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new ObsSubsystemError(
        'OBS_CONNECT_CANCELLED',
        'The OBS connection attempt was cancelled'
      )
    }
  }

  disconnect(): Promise<void> {
    return this.service.disconnect()
  }

  discover(): Promise<{ targets: CaptureTarget[]; audioDevices: AudioDevice[] }> {
    return this.service.discover()
  }

  selectPortalTarget(): Promise<void> {
    return this.service.selectPortalTarget()
  }

  configure(input: CaptureConfiguration): Promise<CaptureStatus> {
    return this.service.configure(input)
  }

  preflight(): Promise<PreflightResult> {
    return this.service.preflight()
  }

  start(sessionId: string, sessionDirectory: string): Promise<CaptureStatus> {
    return this.service.start(sessionId, sessionDirectory)
  }

  async stop(): Promise<{
    status: CaptureStatus
    sessionId: string | null
    outputPath: string | null
    durationMs: number | null
  }> {
    return await this.service.stop()
  }

  acknowledgeRecording(sessionId: string): Promise<void> {
    return this.service.acknowledgeRecording(sessionId)
  }

  status(): Promise<CaptureStatus> {
    return this.service.status()
  }

  subscribe(listener: (status: CaptureStatus) => void): () => void {
    return this.service.subscribe(listener)
  }
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(
        new ObsSubsystemError('OBS_CONNECT_CANCELLED', 'The OBS connection attempt was cancelled')
      )
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, milliseconds)
    timer.unref?.()
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
