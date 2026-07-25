import {
  MANAGED_PROFILE_NAME,
  MANAGED_SCENE_COLLECTION_NAME,
  MANAGED_SCENE_NAME,
  MICROPHONE_INPUT_NAME,
  SYSTEM_AUDIO_INPUT_NAME,
  WINDOW_INPUT_NAME
} from './constants'
import { ObsSubsystemError } from './errors'
import { optionalString, requiredString } from './obsValues'
import type { ObsResourceLeaseStore } from './ObsResourceLeaseStore'
import type { SerializedCommandQueue } from './SerializedCommandQueue'
import type {
  CapturePlatform,
  ManagedInput,
  ManagedResources,
  ObsResourceRestorationLease,
  SessionManifest
} from './types'
import { type LoggerLike, silentLogger } from './types'
import type { ObsGateway } from './ObsGateway'

const PROFILE_PARAMETERS = [
  ['Output', 'Mode', 'Simple'],
  ['SimpleOutput', 'RecFormat2', 'mkv'],
  ['SimpleOutput', 'RecQuality', 'Small'],
  ['SimpleOutput', 'RecAudioEncoder', 'aac'],
  ['SimpleOutput', 'RecTracks', '1'],
  ['SimpleOutput', 'RecRB', 'false'],
  ['Output', 'FilenameFormatting', 'recording-%CCYY-%MM-%DD-%hh-%mm-%ss']
] as const

const PLATFORM_KINDS: Record<
  CapturePlatform,
  { window: string; microphone: string; systemAudio: string | null }
> = {
  windows: {
    window: 'window_capture',
    microphone: 'wasapi_input_capture',
    systemAudio: 'wasapi_output_capture'
  },
  x11: {
    window: 'xcomposite_input',
    microphone: 'pulse_input_capture',
    systemAudio: 'pulse_output_capture'
  },
  wayland: {
    window: 'pipewire-screen-capture-source',
    microphone: 'pulse_input_capture',
    systemAudio: 'pulse_output_capture'
  }
}

export class ObsProvisioner {
  private resources: ManagedResources | null = null
  private restorationLease: ObsResourceRestorationLease | null = null

  constructor(
    private readonly gateway: ObsGateway,
    private readonly queue: SerializedCommandQueue,
    private readonly resourceLeaseStore: ObsResourceLeaseStore,
    private readonly logger: LoggerLike = silentLogger
  ) {}

  get currentResources(): ManagedResources | null {
    return this.resources
  }

  async adoptRestorationLease(manifest: SessionManifest): Promise<void> {
    const existing = await this.resourceLeaseStore.load()
    if (existing) {
      this.restorationLease = existing
      return
    }
    const timestamp = new Date().toISOString()
    this.restorationLease = await this.resourceLeaseStore.save({
      version: 1,
      managedProfileName: manifest.profileName,
      managedSceneCollectionName: manifest.sceneCollectionName,
      previousProfileName: manifest.previousProfileName,
      previousSceneCollectionName: manifest.previousSceneCollectionName,
      createdAt: timestamp,
      updatedAt: timestamp
    })
  }

  attachRecoveredResources(manifest: SessionManifest): ManagedResources {
    const kinds = PLATFORM_KINDS[manifest.platform]
    const lease = this.restorationLease
    const recoveredInput = (
      name: string,
      uuid: string | null,
      kind: string | null
    ): ManagedInput | null => (uuid && kind ? { name, uuid, kind, sceneItemId: null } : null)
    this.resources = {
      profileName: lease?.managedProfileName ?? manifest.profileName,
      sceneCollectionName: lease?.managedSceneCollectionName ?? manifest.sceneCollectionName,
      sceneName: MANAGED_SCENE_NAME,
      previousProfileName: lease?.previousProfileName ?? manifest.previousProfileName,
      previousSceneCollectionName:
        lease?.previousSceneCollectionName ?? manifest.previousSceneCollectionName,
      windowInput: recoveredInput(WINDOW_INPUT_NAME, manifest.windowInputUuid, kinds.window),
      microphoneInput: recoveredInput(
        MICROPHONE_INPUT_NAME,
        manifest.microphoneInputUuid,
        kinds.microphone
      ),
      systemAudioInput: recoveredInput(
        SYSTEM_AUDIO_INPUT_NAME,
        manifest.systemAudioInputUuid,
        kinds.systemAudio
      )
    }
    return this.resources
  }

  async provisionBase(): Promise<ManagedResources> {
    return this.queue.run(async () => {
      const recordStatus = await this.gateway.call('GetRecordStatus')
      if (recordStatus.outputActive) {
        throw new ObsSubsystemError(
          'OBS_EXTERNAL_RECORDING_ACTIVE',
          'OBS is already recording; SessionScribe will not change its profile or scene collection'
        )
      }

      const profiles = await this.gateway.call('GetProfileList')
      const initialCollections = await this.gateway.call('GetSceneCollectionList')
      const lease = await this.loadOrCreateRestorationLease(profiles, initialCollections)
      const managedProfileName = lease.managedProfileName
      const managedSceneCollectionName = lease.managedSceneCollectionName

      if (profiles.profiles.includes(managedProfileName)) {
        if (profiles.currentProfileName !== managedProfileName) {
          await this.gateway.call('SetCurrentProfile', { profileName: managedProfileName })
        }
      } else {
        await this.gateway.call('CreateProfile', { profileName: managedProfileName })
      }

      for (const [parameterCategory, parameterName, parameterValue] of PROFILE_PARAMETERS) {
        await this.gateway.call('SetProfileParameter', {
          parameterCategory,
          parameterName,
          parameterValue
        })
        const readback = await this.gateway.call('GetProfileParameter', {
          parameterCategory,
          parameterName
        })
        if (readback.parameterValue !== parameterValue) {
          throw new ObsSubsystemError(
            'OBS_PROFILE_CONFIGURATION_FAILED',
            `OBS did not retain ${parameterCategory}/${parameterName}`
          )
        }
      }

      await this.gateway.call('SetVideoSettings', {
        baseWidth: 1280,
        baseHeight: 720,
        outputWidth: 1280,
        outputHeight: 720,
        fpsNumerator: 30,
        fpsDenominator: 1
      })
      const video = await this.gateway.call('GetVideoSettings')
      if (
        video.baseWidth !== 1280 ||
        video.baseHeight !== 720 ||
        video.outputWidth !== 1280 ||
        video.outputHeight !== 720 ||
        video.fpsNumerator / video.fpsDenominator !== 30
      ) {
        throw new ObsSubsystemError(
          'OBS_VIDEO_CONFIGURATION_FAILED',
          'OBS did not retain the managed 1280x720 30 fps video configuration'
        )
      }

      const collections = await this.gateway.call('GetSceneCollectionList')
      if (collections.sceneCollections.includes(managedSceneCollectionName)) {
        if (collections.currentSceneCollectionName !== managedSceneCollectionName) {
          await this.gateway.call('SetCurrentSceneCollection', {
            sceneCollectionName: managedSceneCollectionName
          })
        }
      } else {
        await this.gateway.call('CreateSceneCollection', {
          sceneCollectionName: managedSceneCollectionName
        })
      }

      const scenes = await this.gateway.call('GetSceneList')
      const hasManagedScene = scenes.scenes.some(
        (scene) => requiredString(scene, 'sceneName', 'scene') === MANAGED_SCENE_NAME
      )
      if (!hasManagedScene)
        await this.gateway.call('CreateScene', { sceneName: MANAGED_SCENE_NAME })
      await this.gateway.call('SetCurrentProgramScene', { sceneName: MANAGED_SCENE_NAME })

      const specialInputs = await this.gateway.call('GetSpecialInputs')
      for (const inputName of Object.values(specialInputs)) {
        if (typeof inputName !== 'string' || inputName.length === 0) continue
        await this.gateway.call('SetInputMute', { inputName, inputMuted: true })
      }

      this.resources = {
        profileName: managedProfileName,
        sceneCollectionName: managedSceneCollectionName,
        sceneName: MANAGED_SCENE_NAME,
        previousProfileName: lease.previousProfileName,
        previousSceneCollectionName: lease.previousSceneCollectionName,
        windowInput: null,
        microphoneInput: null,
        systemAudioInput: null
      }
      this.logger.info('Provisioned managed OBS profile and scene collection')
      return this.resources
    })
  }

  async ensurePlatformInputs(
    platform: CapturePlatform,
    includeWindow: boolean
  ): Promise<ManagedResources> {
    return this.queue.run(async () => {
      const resources = this.requireResources()
      const kinds = PLATFORM_KINDS[platform]
      const availableKinds = new Set(
        (await this.gateway.call('GetInputKindList', { unversioned: true })).inputKinds
      )
      const requiredKinds = [
        kinds.microphone,
        kinds.systemAudio,
        includeWindow ? kinds.window : null
      ].filter((kind): kind is string => kind !== null)
      const missingKinds = requiredKinds.filter((kind) => !availableKinds.has(kind))
      if (missingKinds.length > 0) {
        throw new ObsSubsystemError(
          'OBS_INPUT_KIND_MISSING',
          `This OBS build is missing required capture sources: ${missingKinds.join(', ')}`
        )
      }

      if (includeWindow) {
        resources.windowInput = await this.ensureInput(WINDOW_INPUT_NAME, kinds.window, {}, true)
        await this.applyWindowTransform(resources.windowInput)
      }
      resources.microphoneInput = await this.ensureInput(
        MICROPHONE_INPUT_NAME,
        kinds.microphone,
        {},
        false
      )
      resources.systemAudioInput = kinds.systemAudio
        ? await this.ensureInput(SYSTEM_AUDIO_INPUT_NAME, kinds.systemAudio, {}, false)
        : null
      return resources
    })
  }

  async ensureWindowInput(platform: CapturePlatform): Promise<ManagedInput> {
    return this.queue.run(async () => {
      const resources = this.requireResources()
      const kind = PLATFORM_KINDS[platform].window
      const inputKinds = new Set(
        (await this.gateway.call('GetInputKindList', { unversioned: true })).inputKinds
      )
      if (!inputKinds.has(kind)) {
        throw new ObsSubsystemError(
          'OBS_INPUT_KIND_MISSING',
          `This OBS build does not provide ${kind}`
        )
      }
      resources.windowInput = await this.ensureInput(WINDOW_INPUT_NAME, kind, {}, true)
      await this.applyWindowTransform(resources.windowInput)
      return resources.windowInput
    })
  }

  async restorePreviousResources(): Promise<void> {
    await this.queue.run(async () => {
      // Nothing was ever mutated in OBS, so a disconnected gateway is not a
      // restore failure. Reading the lease first keeps shutdown quiet instead
      // of reporting a failure for work that never happened.
      const lease = await this.resourceLeaseStore.load()
      if (!lease && !this.gateway.connected) return
      if ((await this.gateway.call('GetRecordStatus')).outputActive) return
      if (!lease) {
        this.restorationLease = null
        this.resources = null
        return
      }
      const collection = await this.gateway.call('GetSceneCollectionList')
      const collectionWasManaged =
        collection.currentSceneCollectionName === lease.managedSceneCollectionName
      if (lease.previousSceneCollectionName && collectionWasManaged) {
        if (!collection.sceneCollections.includes(lease.previousSceneCollectionName)) {
          throw new ObsSubsystemError(
            'OBS_RESOURCE_RESTORE_FAILED',
            `The previous OBS scene collection ${lease.previousSceneCollectionName} is unavailable`
          )
        }
        await this.gateway.call('SetCurrentSceneCollection', {
          sceneCollectionName: lease.previousSceneCollectionName
        })
      }
      const profile = await this.gateway.call('GetProfileList')
      const profileWasManaged = profile.currentProfileName === lease.managedProfileName
      if (lease.previousProfileName && profileWasManaged) {
        if (!profile.profiles.includes(lease.previousProfileName)) {
          throw new ObsSubsystemError(
            'OBS_RESOURCE_RESTORE_FAILED',
            `The previous OBS profile ${lease.previousProfileName} is unavailable`
          )
        }
        await this.gateway.call('SetCurrentProfile', { profileName: lease.previousProfileName })
      }

      const [restoredCollection, restoredProfile] = await Promise.all([
        this.gateway.call('GetSceneCollectionList'),
        this.gateway.call('GetProfileList')
      ])
      const collectionRestored =
        lease.previousSceneCollectionName === null ||
        (collectionWasManaged
          ? restoredCollection.currentSceneCollectionName === lease.previousSceneCollectionName
          : restoredCollection.currentSceneCollectionName !== lease.managedSceneCollectionName)
      const profileRestored =
        lease.previousProfileName === null ||
        (profileWasManaged
          ? restoredProfile.currentProfileName === lease.previousProfileName
          : restoredProfile.currentProfileName !== lease.managedProfileName)
      if (!collectionRestored || !profileRestored) {
        throw new ObsSubsystemError(
          'OBS_RESOURCE_RESTORE_FAILED',
          'OBS did not restore the previous profile and scene collection'
        )
      }
      await this.resourceLeaseStore.remove()
      this.restorationLease = null
      this.resources = null
    })
  }

  private async loadOrCreateRestorationLease(
    profiles: { currentProfileName: string },
    collections: { currentSceneCollectionName: string }
  ): Promise<ObsResourceRestorationLease> {
    const existing = await this.resourceLeaseStore.load()
    if (existing) {
      const previousProfileName =
        profiles.currentProfileName === existing.managedProfileName
          ? existing.previousProfileName
          : profiles.currentProfileName
      const previousSceneCollectionName =
        collections.currentSceneCollectionName === existing.managedSceneCollectionName
          ? existing.previousSceneCollectionName
          : collections.currentSceneCollectionName
      if (
        previousProfileName !== existing.previousProfileName ||
        previousSceneCollectionName !== existing.previousSceneCollectionName
      ) {
        this.restorationLease = await this.resourceLeaseStore.save({
          ...existing,
          previousProfileName,
          previousSceneCollectionName,
          updatedAt: new Date().toISOString()
        })
        return this.restorationLease
      }
      this.restorationLease = existing
      return existing
    }
    const timestamp = new Date().toISOString()
    const lease = await this.resourceLeaseStore.save({
      version: 1,
      managedProfileName: MANAGED_PROFILE_NAME,
      managedSceneCollectionName: MANAGED_SCENE_COLLECTION_NAME,
      previousProfileName:
        profiles.currentProfileName === MANAGED_PROFILE_NAME ? null : profiles.currentProfileName,
      previousSceneCollectionName:
        collections.currentSceneCollectionName === MANAGED_SCENE_COLLECTION_NAME
          ? null
          : collections.currentSceneCollectionName,
      createdAt: timestamp,
      updatedAt: timestamp
    })
    this.restorationLease = lease
    return lease
  }

  private requireResources(): ManagedResources {
    if (!this.resources) {
      throw new ObsSubsystemError(
        'OBS_NOT_PROVISIONED',
        'The managed OBS resources are not provisioned'
      )
    }
    return this.resources
  }

  private async ensureInput(
    inputName: string,
    inputKind: string,
    inputSettings: Record<string, never>,
    sceneItemEnabled: boolean
  ): Promise<ManagedInput> {
    const inputs = await this.gateway.call('GetInputList')
    const existing = inputs.inputs.find((input) => optionalString(input, 'inputName') === inputName)
    if (existing) {
      const existingKind = requiredString(existing, 'unversionedInputKind', 'input')
      if (existingKind !== inputKind) {
        await this.gateway.call('RemoveInput', { inputName })
      } else {
        try {
          const sceneItem = await this.gateway.call('GetSceneItemId', {
            sceneName: MANAGED_SCENE_NAME,
            sourceName: inputName
          })
          await this.gateway.call('SetSceneItemEnabled', {
            sceneName: MANAGED_SCENE_NAME,
            sceneItemId: sceneItem.sceneItemId,
            sceneItemEnabled
          })
          return {
            name: inputName,
            uuid: requiredString(existing, 'inputUuid', 'input'),
            kind: inputKind,
            sceneItemId: sceneItem.sceneItemId
          }
        } catch {
          await this.gateway.call('RemoveInput', { inputName })
        }
      }
    }

    const created = await this.gateway.call('CreateInput', {
      sceneName: MANAGED_SCENE_NAME,
      inputName,
      inputKind,
      inputSettings,
      sceneItemEnabled
    })
    return {
      name: inputName,
      uuid: created.inputUuid,
      kind: inputKind,
      sceneItemId: created.sceneItemId
    }
  }

  private async applyWindowTransform(input: ManagedInput): Promise<void> {
    if (input.sceneItemId === null) return
    await this.gateway.call('SetSceneItemTransform', {
      sceneName: MANAGED_SCENE_NAME,
      sceneItemId: input.sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        alignment: 5,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsAlignment: 0,
        boundsWidth: 1280,
        boundsHeight: 720
      }
    })
  }
}

export function platformKinds(platform: CapturePlatform): {
  window: string
  microphone: string
  systemAudio: string | null
} {
  return PLATFORM_KINDS[platform]
}
