import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'

import { ObsSubsystemError } from './errors'
import type { ObsGateway } from './ObsGateway'
import type { LoggerLike, ObsConnectionOptions, ObsExecutable } from './types'
import { silentLogger } from './types'

const execFileAsync = promisify(execFile)

export interface ObsDiscoveryOptions {
  configuredExecutable?: string
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  retryIntervalMs?: number
  launchTimeoutMs?: number
}

export class ObsDiscovery {
  private readonly environment: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform

  constructor(
    private readonly gateway: ObsGateway,
    private readonly options: ObsDiscoveryOptions = {},
    private readonly logger: LoggerLike = silentLogger
  ) {
    this.environment = options.environment ?? process.env
    this.platform = options.platform ?? process.platform
  }

  async locate(): Promise<ObsExecutable | null> {
    if (
      this.options.configuredExecutable &&
      (await this.exists(this.options.configuredExecutable))
    ) {
      return this.native(this.options.configuredExecutable)
    }

    if (this.platform === 'win32') {
      const candidates = [
        this.environment.ProgramFiles
          ? join(this.environment.ProgramFiles, 'obs-studio', 'bin', '64bit', 'obs64.exe')
          : null,
        this.environment['ProgramFiles(x86)']
          ? join(this.environment['ProgramFiles(x86)'], 'obs-studio', 'bin', '64bit', 'obs64.exe')
          : null
      ]
      for (const candidate of candidates) {
        if (candidate && (await this.exists(candidate))) return this.native(candidate)
      }
      return this.findOnPath('obs64.exe')
    }

    if (this.platform === 'linux') {
      const native = await this.findOnPath('obs')
      if (native) return native
      try {
        await execFileAsync('flatpak', ['info', 'com.obsproject.Studio'], {
          env: this.environment,
          timeout: 5_000
        })
        return {
          command: 'flatpak',
          args: ['run', 'com.obsproject.Studio'],
          kind: 'flatpak'
        }
      } catch {
        return null
      }
    }

    return null
  }

  launch(executable: ObsExecutable): void {
    const child = spawn(executable.command, [...executable.args, '--minimize-to-tray'], {
      cwd: executable.cwd,
      env: this.environment,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', (error) => {
      this.logger.warn('OBS Studio could not be launched', { error: error.message })
    })
    child.unref()
    this.logger.info('Launched OBS Studio', { kind: executable.kind })
  }

  async connectOrLaunch(connection: ObsConnectionOptions): Promise<void> {
    try {
      await this.gateway.connect(connection)
      return
    } catch (initialError) {
      if (!this.isConnectionUnavailable(initialError)) throw initialError
      const executable = await this.locate()
      if (!executable) throw initialError
      this.launch(executable)
    }

    const deadline = Date.now() + (this.options.launchTimeoutMs ?? 30_000)
    let lastError: unknown = null
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.options.retryIntervalMs ?? 500))
      try {
        await this.gateway.connect(connection)
        return
      } catch (error) {
        lastError = error
      }
    }
    throw new ObsSubsystemError(
      'OBS_LAUNCH_TIMEOUT',
      'OBS launched but its websocket server did not become available. Enable it in OBS Tools settings.',
      lastError
    )
  }

  private native(command: string): ObsExecutable {
    if (this.platform === 'win32') {
      return { command, args: [], cwd: dirname(command), kind: 'native' }
    }
    return { command, args: [], kind: 'native' }
  }

  private async findOnPath(command: string): Promise<ObsExecutable | null> {
    for (const directory of (this.environment.PATH ?? '').split(delimiter)) {
      if (!directory) continue
      const candidate = join(directory, command)
      if (await this.exists(candidate)) return this.native(candidate)
    }
    return null
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  private isConnectionUnavailable(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false
    return error.code === -1 || error.code === 'ECONNREFUSED'
  }
}
