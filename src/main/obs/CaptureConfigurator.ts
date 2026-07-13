import type { AudioDevice, CaptureConfiguration, CaptureTarget } from '@shared/capture'

import { ObsSubsystemError } from './errors'
import { parsePropertyItems } from './obsValues'
import type { ObsGateway } from './ObsGateway'
import type { ObsProvisioner } from './ObsProvisioner'
import type {
  CaptureDiscovery,
  CapturePlatform,
  ConfiguredCapture,
  ManagedInput,
  ManagedResources
} from './types'

const TARGET_PROPERTIES: Record<Exclude<CapturePlatform, 'wayland'>, string> = {
  windows: 'window',
  x11: 'capture_window'
}

export function detectCapturePlatform(
  nodePlatform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): CapturePlatform {
  if (nodePlatform === 'win32') return 'windows'
  if (nodePlatform !== 'linux') {
    throw new ObsSubsystemError(
      'OBS_PLATFORM_UNSUPPORTED',
      'Only Windows and Linux capture are supported'
    )
  }
  return environment.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' ? 'wayland' : 'x11'
}

export class CaptureConfigurator {
  private discovery: CaptureDiscovery | null = null
  private configured: ConfiguredCapture | null = null

  constructor(
    private readonly gateway: ObsGateway,
    private readonly provisioner: ObsProvisioner,
    readonly platform: CapturePlatform
  ) {}

  get currentConfiguration(): ConfiguredCapture | null {
    return this.configured
  }

  async discover(): Promise<CaptureDiscovery> {
    const includeWindow = this.platform !== 'wayland'
    const resources = await this.provisioner.ensurePlatformInputs(this.platform, includeWindow)
    const targets = await this.discoverTargets(resources)
    const audioDevices = await this.discoverAudio(resources)
    this.discovery = { targets, audioDevices }
    return this.discovery
  }

  async configure(configuration: CaptureConfiguration): Promise<ConfiguredCapture> {
    const discovery = this.discovery ?? (await this.discover())
    const selectedTarget = configuration.targetId
      ? (discovery.targets.find((target) => target.id === configuration.targetId) ?? null)
      : null
    if (configuration.targetId && !selectedTarget) {
      throw new ObsSubsystemError(
        'OBS_TARGET_UNKNOWN',
        'The selected capture target is no longer available'
      )
    }
    if (
      configuration.microphoneDeviceId &&
      !discovery.audioDevices.some(
        (device) => device.kind === 'microphone' && device.id === configuration.microphoneDeviceId
      )
    ) {
      throw new ObsSubsystemError(
        'OBS_AUDIO_DEVICE_UNKNOWN',
        'The selected microphone is no longer available'
      )
    }
    if (
      configuration.outputDeviceId &&
      !discovery.audioDevices.some(
        (device) => device.kind !== 'microphone' && device.id === configuration.outputDeviceId
      )
    ) {
      throw new ObsSubsystemError(
        'OBS_AUDIO_DEVICE_UNKNOWN',
        'The selected system or window audio source is no longer available'
      )
    }

    const resources = this.provisioner.currentResources
    if (!resources) throw new ObsSubsystemError('OBS_NOT_PROVISIONED', 'OBS is not provisioned')

    if (!resources.windowInput && configuration.targetId) {
      resources.windowInput = await this.provisioner.ensureWindowInput(this.platform)
    }
    if (configuration.targetId && resources.windowInput) {
      await this.configureWindow(resources.windowInput, configuration)
    } else if (resources.windowInput) {
      await this.setEnabled(resources.windowInput, false)
    }

    await this.configureAudioInput(
      resources.microphoneInput,
      configuration.microphoneDeviceId,
      'microphone'
    )

    const usesWindowAudio =
      this.platform === 'windows' && configuration.outputDeviceId === 'window-audio'
    await this.configureAudioInput(
      resources.systemAudioInput,
      usesWindowAudio ? null : configuration.outputDeviceId,
      'output'
    )

    if (resources.windowInput && this.platform === 'windows') {
      await this.gateway.call('SetInputSettings', {
        inputUuid: resources.windowInput.uuid,
        inputSettings: { capture_audio: usesWindowAudio },
        overlay: true
      })
    }

    this.configured = {
      configuration: { ...configuration },
      platform: this.platform,
      resources,
      selectedTarget
    }
    return this.configured
  }

  async selectAnotherWaylandTarget(): Promise<void> {
    if (this.platform !== 'wayland') {
      throw new ObsSubsystemError(
        'OBS_PORTAL_UNAVAILABLE',
        'The portal selector is only used on Wayland'
      )
    }
    const resources = this.provisioner.currentResources
    if (!resources) {
      throw new ObsSubsystemError('OBS_NOT_PROVISIONED', 'OBS is not provisioned')
    }
    const input = resources.windowInput ?? (await this.provisioner.ensureWindowInput(this.platform))
    await this.gateway.call('PressInputPropertiesButton', {
      inputUuid: input.uuid,
      propertyName: 'Reload'
    })
  }

  private async discoverTargets(resources: ManagedResources): Promise<CaptureTarget[]> {
    if (this.platform === 'wayland') {
      return [
        {
          id: 'wayland-portal',
          label: 'Choose a window',
          platform: 'wayland',
          requiresPortal: true
        }
      ]
    }

    if (!resources.windowInput) return []
    const response = await this.gateway.call('GetInputPropertiesListPropertyItems', {
      inputUuid: resources.windowInput.uuid,
      propertyName: TARGET_PROPERTIES[this.platform]
    })
    return parsePropertyItems(response.propertyItems)
      .filter((item) => item.enabled && item.value.length > 0)
      .map((item) => ({
        id: item.value,
        label: item.name,
        platform: this.platform,
        requiresPortal: false
      }))
  }

  private async discoverAudio(resources: ManagedResources): Promise<AudioDevice[]> {
    const devices: AudioDevice[] = []
    if (this.platform === 'windows') {
      devices.push({ id: 'window-audio', label: 'Selected window audio', kind: 'window' })
    }
    if (resources.microphoneInput) {
      devices.push(...(await this.propertyDevices(resources.microphoneInput, 'microphone')))
    }
    if (resources.systemAudioInput) {
      devices.push(...(await this.propertyDevices(resources.systemAudioInput, 'output')))
    }
    return devices
  }

  private async propertyDevices(
    input: ManagedInput,
    kind: 'microphone' | 'output'
  ): Promise<AudioDevice[]> {
    const response = await this.gateway.call('GetInputPropertiesListPropertyItems', {
      inputUuid: input.uuid,
      propertyName: 'device_id'
    })
    return parsePropertyItems(response.propertyItems)
      .filter((item) => item.enabled && item.value.length > 0)
      .map((item) => ({ id: item.value, label: item.name, kind }))
  }

  private async configureWindow(
    input: ManagedInput,
    configuration: CaptureConfiguration
  ): Promise<void> {
    if (this.platform === 'windows') {
      await this.gateway.call('SetInputSettings', {
        inputUuid: input.uuid,
        inputSettings: {
          window: configuration.targetId ?? '',
          method: 0,
          cursor: configuration.captureCursor,
          client_area: true,
          capture_audio: configuration.outputDeviceId === 'window-audio'
        },
        overlay: true
      })
    } else if (this.platform === 'x11') {
      await this.gateway.call('SetInputSettings', {
        inputUuid: input.uuid,
        inputSettings: {
          capture_window: configuration.targetId ?? '',
          show_cursor: configuration.captureCursor
        },
        overlay: true
      })
    } else {
      await this.gateway.call('SetInputSettings', {
        inputUuid: input.uuid,
        inputSettings: { ShowCursor: configuration.captureCursor },
        overlay: true
      })
    }
    await this.setEnabled(input, true)
  }

  private async configureAudioInput(
    input: ManagedInput | null,
    deviceId: string | null,
    kind: 'microphone' | 'output'
  ): Promise<void> {
    if (!input) {
      if (deviceId) {
        throw new ObsSubsystemError('OBS_AUDIO_INPUT_MISSING', `OBS has no managed ${kind} input`)
      }
      return
    }
    const enabled = deviceId !== null
    if (deviceId) {
      await this.gateway.call('SetInputSettings', {
        inputUuid: input.uuid,
        inputSettings: { device_id: deviceId },
        overlay: true
      })
    }
    await this.gateway.call('SetInputAudioTracks', {
      inputUuid: input.uuid,
      inputAudioTracks: {
        '1': enabled,
        '2': false,
        '3': false,
        '4': false,
        '5': false,
        '6': false
      }
    })
    await this.gateway.call('SetInputMute', { inputUuid: input.uuid, inputMuted: !enabled })
    await this.setEnabled(input, enabled)
  }

  private async setEnabled(input: ManagedInput, enabled: boolean): Promise<void> {
    if (input.sceneItemId === null) return
    await this.gateway.call('SetSceneItemEnabled', {
      sceneName: this.provisioner.currentResources?.sceneName ?? 'Capture',
      sceneItemId: input.sceneItemId,
      sceneItemEnabled: enabled
    })
  }
}
