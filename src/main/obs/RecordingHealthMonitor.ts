import { EventEmitter } from 'node:events'

import type { ObsGateway } from './ObsGateway'
import type { RecordingTelemetry } from './types'

type HealthEvents = {
  telemetry: [telemetry: RecordingTelemetry]
  warning: [warning: string]
  error: [error: Error]
}

export interface RecordingHealthMonitorOptions {
  intervalMs?: number
  stallAfterMs?: number
  lowDiskMb?: number
  now?: () => number
}

export class RecordingHealthMonitor extends EventEmitter<HealthEvents> {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private previousBytes = -1
  private previousDuration = -1
  private lastProgressAt = 0
  private readonly now: () => number

  constructor(
    private readonly gateway: ObsGateway,
    private readonly options: RecordingHealthMonitorOptions = {}
  ) {
    super()
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.lastProgressAt = this.now()
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 2_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.previousBytes = -1
    this.previousDuration = -1
  }

  async sample(): Promise<RecordingTelemetry> {
    const [record, stats] = await Promise.all([
      this.gateway.call('GetRecordStatus'),
      this.gateway.call('GetStats')
    ])
    return {
      active: record.outputActive,
      paused: record.outputPaused,
      durationMs: Math.max(0, Math.trunc(record.outputDuration)),
      bytes: Math.max(0, Math.trunc(record.outputBytes)),
      availableDiskSpaceMb: Math.max(0, stats.availableDiskSpace),
      renderSkippedFrames: Math.max(0, Math.trunc(stats.renderSkippedFrames)),
      renderTotalFrames: Math.max(0, Math.trunc(stats.renderTotalFrames)),
      outputSkippedFrames: Math.max(0, Math.trunc(stats.outputSkippedFrames)),
      outputTotalFrames: Math.max(0, Math.trunc(stats.outputTotalFrames))
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.gateway.connected) return
    this.ticking = true
    try {
      const telemetry = await this.sample()
      const progressed =
        telemetry.bytes > this.previousBytes || telemetry.durationMs > this.previousDuration
      if (progressed) this.lastProgressAt = this.now()
      if (
        telemetry.active &&
        !telemetry.paused &&
        this.now() - this.lastProgressAt >= (this.options.stallAfterMs ?? 10_000)
      ) {
        this.emit('warning', 'OBS recording output has stopped making progress.')
      }
      if (telemetry.availableDiskSpaceMb < (this.options.lowDiskMb ?? 2_048)) {
        this.emit('warning', 'Recording disk space is critically low.')
      }
      if (
        telemetry.outputTotalFrames > 0 &&
        telemetry.outputSkippedFrames / telemetry.outputTotalFrames > 0.01
      ) {
        this.emit('warning', 'OBS is skipping more than 1% of output frames.')
      }
      this.previousBytes = telemetry.bytes
      this.previousDuration = telemetry.durationMs
      this.emit('telemetry', telemetry)
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.ticking = false
    }
  }
}
