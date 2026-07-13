import { resolve } from 'node:path'

import { ObsSubsystemError } from './errors'
import type { ObsGateway } from './ObsGateway'
import type { RecordingController } from './RecordingController'
import type { SessionManifestStore } from './SessionManifestStore'
import type { RecoveryResult } from './types'

export class RecoveryService {
  constructor(
    private readonly gateway: ObsGateway,
    private readonly manifestStore: SessionManifestStore,
    private readonly controller: RecordingController
  ) {}

  async recover(): Promise<RecoveryResult | null> {
    const manifest = await this.manifestStore.load()
    if (!manifest) return null

    if (manifest.state === 'failed') {
      await this.controller.attach(manifest)
      return { manifest, action: 'failed', artifacts: [] }
    }

    if (manifest.state === 'complete' || manifest.state === 'interrupted') {
      try {
        const artifacts = await this.controller.finalizeRecovered(
          manifest,
          manifest.state === 'interrupted'
        )
        return {
          manifest,
          action: manifest.state === 'complete' ? 'finalized' : 'interrupted',
          artifacts
        }
      } catch {
        return {
          manifest: (await this.manifestStore.load()) ?? manifest,
          action: 'interrupted',
          artifacts: []
        }
      }
    }

    if (this.gateway.connected) {
      const [record, directory] = await Promise.all([
        this.gateway.call('GetRecordStatus'),
        this.gateway.call('GetRecordDirectory')
      ])
      if (record.outputActive) {
        if (resolve(directory.recordDirectory) !== resolve(manifest.recordDirectory)) {
          return { manifest, action: 'ownership-conflict', artifacts: [] }
        }
        if (!['start-intent', 'recording', 'stop-intent'].includes(manifest.state)) {
          throw new ObsSubsystemError(
            'OBS_RECOVERY_STATE_INVALID',
            `OBS is recording but the manifest is ${manifest.state}`
          )
        }
        manifest.state = manifest.state === 'stop-intent' ? 'stop-intent' : 'recording'
        manifest.lastDurationMs = Math.max(0, Math.trunc(record.outputDuration))
        manifest.lastBytes = Math.max(0, Math.trunc(record.outputBytes))
        await this.manifestStore.save(manifest)
        await this.controller.attach(manifest)
        return { manifest, action: 'reattached', artifacts: [] }
      }
      if (
        (manifest.state === 'ready' || manifest.state === 'configuring') &&
        manifest.outputPaths.length === 0
      ) {
        manifest.state = 'failed'
        manifest.error =
          manifest.error ?? 'The application stopped before OBS was asked to start recording.'
        manifest.updatedAt = new Date().toISOString()
        await this.manifestStore.save(manifest)
        await this.controller.attach(manifest)
        return { manifest, action: 'failed', artifacts: [] }
      }
    }

    try {
      const artifacts = await this.controller.finalizeRecovered(manifest, true)
      return { manifest, action: 'interrupted', artifacts }
    } catch {
      return {
        manifest: (await this.manifestStore.load()) ?? manifest,
        action: 'interrupted',
        artifacts: []
      }
    }
  }
}
