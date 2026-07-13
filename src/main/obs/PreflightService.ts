import { access, mkdir, open, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

import type { PreflightResult } from '@shared/capture'

import {
  MANAGED_PROFILE_NAME,
  MANAGED_SCENE_COLLECTION_NAME,
  MANAGED_SCENE_NAME
} from './constants'
import { toErrorMessage } from './errors'
import type { ObsGateway } from './ObsGateway'
import type { ConfiguredCapture } from './types'

export interface PreflightOptions {
  scratchDirectory: string
  minimumDiskMb?: number
  warningDiskMb?: number
}

export class PreflightService {
  constructor(
    private readonly gateway: ObsGateway,
    private readonly options: PreflightOptions
  ) {}

  async run(capture: ConfiguredCapture): Promise<PreflightResult> {
    const blockers: string[] = []
    const warnings: string[] = []
    let screenshotDataUrl: string | null = null

    if (!this.gateway.connected) blockers.push('OBS is not connected.')
    if (!capture.configuration.targetId || !capture.resources.windowInput) {
      blockers.push('Choose a window to record.')
    }
    if (!capture.configuration.microphoneDeviceId && !capture.configuration.outputDeviceId) {
      blockers.push('Choose at least one audio source.')
    }

    let mayChangeRecordDirectory = false
    try {
      const record = await this.gateway.call('GetRecordStatus')
      if (record.outputActive) blockers.push('OBS is already recording.')
      else mayChangeRecordDirectory = true
      const profiles = await this.gateway.call('GetProfileList')
      if (profiles.currentProfileName !== MANAGED_PROFILE_NAME) {
        blockers.push('The managed OBS profile is not active.')
      }
      const collections = await this.gateway.call('GetSceneCollectionList')
      if (collections.currentSceneCollectionName !== MANAGED_SCENE_COLLECTION_NAME) {
        blockers.push('The managed OBS scene collection is not active.')
      }
      const scene = await this.gateway.call('GetCurrentProgramScene')
      if (scene.currentProgramSceneName !== MANAGED_SCENE_NAME) {
        blockers.push('The managed capture scene is not active.')
      }
    } catch (error) {
      mayChangeRecordDirectory = false
      blockers.push(`OBS state could not be verified: ${toErrorMessage(error)}`)
    }

    if (mayChangeRecordDirectory) {
      try {
        await this.ensureWritableDirectory()
        await this.gateway.call('SetRecordDirectory', {
          recordDirectory: resolve(this.options.scratchDirectory)
        })
        const configuredDirectory = await this.gateway.call('GetRecordDirectory')
        if (
          resolve(configuredDirectory.recordDirectory) !== resolve(this.options.scratchDirectory)
        ) {
          blockers.push('OBS could not use the recording directory.')
        }
      } catch (error) {
        blockers.push(`The recording directory is not writable: ${toErrorMessage(error)}`)
      }
    }

    const windowInput = capture.resources.windowInput
    if (windowInput) {
      try {
        const active = await this.gateway.call('GetSourceActive', { sourceUuid: windowInput.uuid })
        if (!active.videoActive)
          blockers.push('The selected window is not active in the OBS program scene.')
        const screenshot = await this.gateway.call('GetSourceScreenshot', {
          sourceUuid: windowInput.uuid,
          imageFormat: 'jpeg',
          imageWidth: 320,
          imageHeight: 180,
          imageCompressionQuality: 70
        })
        screenshotDataUrl = screenshot.imageData
        if (screenshot.imageData.length < 256)
          warnings.push('The selected window preview may be blank.')
      } catch (error) {
        blockers.push(`The selected window cannot be captured: ${toErrorMessage(error)}`)
      }
    }

    try {
      const stats = await this.gateway.call('GetStats')
      const minimumDiskMb = this.options.minimumDiskMb ?? 2_048
      const warningDiskMb = this.options.warningDiskMb ?? 10_240
      if (stats.availableDiskSpace < minimumDiskMb) {
        blockers.push(`At least ${minimumDiskMb} MB of free recording space is required.`)
      } else if (stats.availableDiskSpace < warningDiskMb) {
        warnings.push('Less than 10 GB of recording space is available.')
      }
      if (
        stats.renderTotalFrames > 0 &&
        stats.renderSkippedFrames / stats.renderTotalFrames > 0.01
      ) {
        warnings.push('OBS is currently skipping more than 1% of rendered frames.')
      }
    } catch (error) {
      blockers.push(`OBS performance statistics are unavailable: ${toErrorMessage(error)}`)
    }

    return { ok: blockers.length === 0, blockers, warnings, screenshotDataUrl }
  }

  private async ensureWritableDirectory(): Promise<void> {
    await mkdir(this.options.scratchDirectory, { recursive: true })
    await access(this.options.scratchDirectory, constants.W_OK)
    const marker = resolve(
      this.options.scratchDirectory,
      `.sessionscribe-${process.pid}.write-test`
    )
    const handle = await open(marker, 'wx', 0o600)
    await handle.close()
    await rm(marker, { force: true })
  }
}
