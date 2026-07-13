import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ObsGateway } from './ObsGateway'
import { ObsDiscovery } from './ObsDiscovery'

describe('ObsDiscovery', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, {
          recursive: true,
          force: true
        })
      )
    )
  })

  it('reads the Flatpak WebSocket settings without exposing the password', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-settings-'))
    temporaryDirectories.push(home)
    const configPath = join(
      home,
      '.var/app/com.obsproject.Studio/config/obs-studio/plugin_config/obs-websocket/config.json'
    )
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({ server_enabled: false, server_port: 4455, server_password: 'private' })
    )
    const discovery = new ObsDiscovery({} as ObsGateway, {
      platform: 'linux',
      environment: { HOME: home, PATH: '' }
    })

    await expect(
      discovery.readWebSocketSettings({
        command: 'flatpak',
        args: ['run', 'com.obsproject.Studio'],
        kind: 'flatpak'
      })
    ).resolves.toEqual({ enabled: false, port: 4455 })
  })

  it('rejects immediately when the OBS process cannot be spawned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-obs-launch-'))
    temporaryDirectories.push(root)
    const discovery = new ObsDiscovery({} as ObsGateway, {
      platform: 'linux',
      environment: { HOME: root, PATH: '' }
    })

    await expect(
      discovery.launch({ command: join(root, 'missing-obs'), args: [], kind: 'native' })
    ).rejects.toMatchObject({ code: 'OBS_LAUNCH_FAILED' })
  })
})
