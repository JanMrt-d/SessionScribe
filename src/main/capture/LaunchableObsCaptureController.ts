import type {
  AudioDevice,
  CaptureConfiguration,
  CaptureStatus,
  CaptureTarget,
  PreflightResult
} from '@shared/index'
import type { CaptureController } from '../app/contracts'
import { ObsDiscovery, ObsSubsystemError } from '../obs/index'
import type { ObsCaptureService } from '../obs/index'

export class LaunchableObsCaptureController implements CaptureController {
  private readonly discovery: ObsDiscovery

  constructor(private readonly service: ObsCaptureService) {
    this.discovery = new ObsDiscovery(service.gateway)
  }

  async connect(input: { url: string; password: string }): Promise<CaptureStatus> {
    try {
      return await this.service.connect(input)
    } catch (initialError) {
      if (!isConnectionUnavailable(initialError)) throw initialError
      const executable = await this.discovery.locate()
      if (!executable) throw initialError
      this.discovery.launch(executable)
      const deadline = Date.now() + 30_000
      let lastError: unknown = initialError
      while (Date.now() < deadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 750))
        try {
          return await this.service.connect(input)
        } catch (error) {
          if (!isConnectionUnavailable(error)) throw error
          lastError = error
        }
      }
      throw new ObsSubsystemError(
        'OBS_LAUNCH_TIMEOUT',
        'OBS launched, but its WebSocket server did not become available. Enable it under Tools > WebSocket Server Settings.',
        lastError
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

function isConnectionUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? error.code : null
  return code === -1 || code === 'ECONNREFUSED'
}
