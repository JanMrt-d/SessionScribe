import { spawn } from 'node:child_process'

import { ManagedWhisperError, managedWhisperCancelled } from './errors'

const MAX_CAPTURED_BYTES = 64 * 1_024
const FORCE_KILL_DELAY_MS = 1_000

export interface WhisperCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly outputTruncated: boolean
}

export interface WhisperCommandOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface WhisperCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options?: WhisperCommandOptions
  ): Promise<WhisperCommandResult>
}

export class SpawnWhisperCommandRunner implements WhisperCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options: WhisperCommandOptions = {}
  ): Promise<WhisperCommandResult> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(managedWhisperCancelled(options.signal.reason))
        return
      }

      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let outputTruncated = false
      let settled = false
      let terminationError: Error | null = null
      let timeout: NodeJS.Timeout | undefined
      let forceKill: NodeJS.Timeout | undefined

      const capture = (target: Buffer[], chunk: Buffer, currentBytes: number): number => {
        const remaining = MAX_CAPTURED_BYTES - currentBytes
        if (remaining <= 0) {
          outputTruncated = true
          return currentBytes
        }
        if (chunk.length > remaining) {
          target.push(chunk.subarray(0, remaining))
          outputTruncated = true
          return MAX_CAPTURED_BYTES
        }
        target.push(chunk)
        return currentBytes + chunk.length
      }

      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const rejectOnce = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const terminate = (error: Error): void => {
        if (terminationError) return
        terminationError = error
        if (timeout) clearTimeout(timeout)
        child.kill('SIGTERM')
        forceKill = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_DELAY_MS)
        forceKill.unref()
      }
      const onAbort = (): void => {
        terminate(managedWhisperCancelled(options.signal?.reason))
      }

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes = capture(stdout, chunk, stdoutBytes)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes = capture(stderr, chunk, stderrBytes)
      })
      child.once('error', (cause) => {
        if (forceKill) clearTimeout(forceKill)
        rejectOnce(
          new ManagedWhisperError('DOCKER_UNAVAILABLE', 'Docker could not be started.', { cause })
        )
      })
      child.once('close', (exitCode) => {
        if (settled) return
        settled = true
        if (forceKill) clearTimeout(forceKill)
        cleanup()
        if (terminationError) {
          reject(terminationError)
          return
        }
        resolve({
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          outputTruncated
        })
      })

      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          terminate(
            new ManagedWhisperError('DOCKER_UNAVAILABLE', 'Docker did not respond in time.')
          )
        }, options.timeoutMs)
        timeout.unref()
      }
    })
  }
}
