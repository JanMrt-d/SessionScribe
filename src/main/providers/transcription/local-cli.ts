import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { ProviderCapabilities } from '@shared/providers'
import type { ProviderContext, TranscriptionAdapter, TranscriptionRequest } from '../contracts'
import { providerNow, reportProgress } from '../contracts'
import { ProviderError, normalizeProviderError } from '../errors'
import { normalizeTranscript, parseCanonicalTranscript } from '../normalize'
import { parseElevenLabsTranscript } from './elevenlabs'
import { parseOpenAiTranscript } from './openai'
import type { LocalCliTranscriptionProfileV1 } from './types'

const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export class LocalCliTranscriptionAdapter implements TranscriptionAdapter<LocalCliTranscriptionProfileV1> {
  readonly kind = 'local-cli' as const

  capabilities(profile: LocalCliTranscriptionProfileV1): ProviderCapabilities {
    return {
      timestamps:
        profile.outputFormat === 'canonical-v1' ||
        profile.outputFormat === 'openai-verbose-json' ||
        profile.outputFormat === 'elevenlabs-json',
      diarization:
        profile.outputFormat === 'canonical-v1' || profile.outputFormat === 'elevenlabs-json',
      structuredOutput: profile.outputFormat !== 'text',
      modelListing: false,
      maxInputBytes: null,
      maxDurationMs: null
    }
  }

  async transcribe(
    request: TranscriptionRequest,
    profile: LocalCliTranscriptionProfileV1,
    context: ProviderContext
  ) {
    let temporaryDirectory: string | undefined
    try {
      reportProgress(context, { stage: 'preflight', progress: 0 })
      validateProfile(profile)
      const input = await stat(request.filePath)
      if (!input.isFile()) throw new Error('The transcription input is not a file')
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'session-scribe-transcription-'))
      const outputPath = join(temporaryDirectory, outputFileName(profile.outputFormat))
      const language = request.languageHint ?? ''
      const substitutions: Readonly<Record<string, string>> = {
        input: request.filePath,
        output: outputPath,
        model: profile.model,
        language
      }
      const args = profile.args.map((argument) => substituteArgument(argument, substitutions))
      const environment = await resolveEnvironment(profile, context)

      reportProgress(context, { stage: 'process', progress: 0.1 })
      const result = await executeProcess(
        profile.executable,
        args,
        environment,
        profile.timeoutMs,
        context
      )
      const output =
        profile.outputMode === 'stdout'
          ? result.stdout
          : await readBoundedOutputFile(outputPath, this.kind)
      reportProgress(context, { stage: 'parse', progress: 0.9 })
      const metadata = {
        sessionId: request.sessionId,
        sourceSha256: request.sourceSha256,
        durationMs: request.durationMs,
        providerKind: this.kind,
        model: profile.model,
        generatedAt: providerNow(context).toISOString()
      }
      let transcript
      try {
        if (profile.outputFormat === 'canonical-v1') {
          transcript = parseCanonicalTranscript(JSON.parse(output), metadata)
        } else if (profile.outputFormat === 'openai-verbose-json') {
          transcript = normalizeTranscript(parseOpenAiTranscript(JSON.parse(output)), metadata)
        } else if (profile.outputFormat === 'elevenlabs-json') {
          transcript = normalizeTranscript(parseElevenLabsTranscript(JSON.parse(output)), metadata)
        } else {
          transcript = normalizeTranscript({ text: output.trim() }, metadata)
        }
      } catch (cause) {
        throw new ProviderError('OUTPUT_INVALID', 'The local transcription output is invalid', {
          providerKind: this.kind,
          operation: 'transcribe',
          stage: 'parse',
          cause
        })
      }
      reportProgress(context, { stage: 'parse', progress: 1 })
      return transcript
    } catch (error) {
      throw normalizeProviderError(error, {
        providerKind: this.kind,
        operation: 'transcribe',
        stage: 'process'
      })
    } finally {
      if (temporaryDirectory) {
        try {
          await rm(temporaryDirectory, { recursive: true, force: true })
        } catch {
          context.logger?.warn('Failed to remove a local transcription temporary directory')
        }
      }
    }
  }
}

function validateProfile(profile: LocalCliTranscriptionProfileV1): void {
  if (!isAbsolute(profile.executable)) {
    throw new ProviderError(
      'INVALID_CONFIG',
      'The local CLI executable must use an absolute path',
      {
        providerKind: 'local-cli',
        operation: 'transcribe',
        stage: 'preflight'
      }
    )
  }
  if (Object.keys(profile.extraHeaders).length > 0) {
    throw new ProviderError('INVALID_CONFIG', 'HTTP headers cannot be configured for a local CLI', {
      providerKind: 'local-cli',
      operation: 'transcribe',
      stage: 'preflight'
    })
  }
  if (!profile.args.some((argument) => argument.includes('{input}'))) {
    throw new ProviderError(
      'INVALID_CONFIG',
      'Local CLI arguments require an {input} placeholder',
      {
        providerKind: 'local-cli',
        operation: 'transcribe',
        stage: 'preflight'
      }
    )
  }
  if (
    profile.outputMode === 'file' &&
    !profile.args.some((argument) => argument.includes('{output}'))
  ) {
    throw new ProviderError(
      'INVALID_CONFIG',
      'File output requires an {output} argument placeholder',
      {
        providerKind: 'local-cli',
        operation: 'transcribe',
        stage: 'preflight'
      }
    )
  }
}

async function resolveEnvironment(
  profile: LocalCliTranscriptionProfileV1,
  context: ProviderContext
): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = profile.inheritEnvironment
    ? { ...process.env }
    : pickEnvironment(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME'])
  for (const [key, reference] of Object.entries(profile.secretRefs)) {
    if (!key.startsWith('env:')) {
      throw new ProviderError('INVALID_CONFIG', `Unsupported CLI secret reference key: ${key}`, {
        providerKind: 'local-cli',
        operation: 'transcribe',
        stage: 'preflight'
      })
    }
    const name = key.slice('env:'.length)
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new ProviderError('INVALID_CONFIG', 'A CLI environment variable name is invalid', {
        providerKind: 'local-cli',
        operation: 'transcribe',
        stage: 'preflight'
      })
    }
    const value = await context.secrets.get(reference, context.signal)
    if (!value) {
      throw new ProviderError('SECRET_MISSING', 'A configured CLI secret is unavailable', {
        providerKind: 'local-cli',
        operation: 'transcribe',
        stage: 'preflight'
      })
    }
    environment[name] = value
  }
  return environment
}

function pickEnvironment(names: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name]
      return value === undefined ? [] : [[name, value]]
    })
  )
}

function substituteArgument(argument: string, values: Readonly<Record<string, string>>): string {
  return argument.replace(
    /\{(input|output|model|language)\}/g,
    (_match, name: string) => values[name] ?? ''
  )
}

function executeProcess(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  context: ProviderContext
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    if (context.signal.aborted) {
      reject(cancelledError(context.signal.reason))
      return
    }
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let overflow = false
    let pendingError: ProviderError | undefined
    let forceKillTimer: NodeJS.Timeout | undefined

    const finish = (error?: ProviderError): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      context.signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8') })
    }
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // The process may have exited between the status check and signal.
        }
      }
      child.kill(signal)
    }
    const stop = (error: ProviderError): void => {
      if (pendingError) return
      pendingError = error
      terminate('SIGTERM')
      forceKillTimer = setTimeout(() => terminate('SIGKILL'), 1_000)
      forceKillTimer.unref()
    }
    const onAbort = (): void => {
      stop(cancelledError(context.signal.reason))
    }
    const timeoutTimer = setTimeout(() => {
      stop(
        new ProviderError('TIMEOUT', 'The local transcription process timed out', {
          providerKind: 'local-cli',
          operation: 'transcribe',
          stage: 'process',
          retryable: true
        })
      )
    }, timeoutMs)
    context.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) {
        overflow = true
        stop(
          new ProviderError(
            'OUTPUT_INVALID',
            'The local transcription process produced too much output',
            {
              providerKind: 'local-cli',
              operation: 'transcribe',
              stage: 'process'
            }
          )
        )
      } else {
        stdout.push(chunk)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) {
        overflow = true
        stop(
          new ProviderError(
            'OUTPUT_INVALID',
            'The local transcription process produced too much output',
            {
              providerKind: 'local-cli',
              operation: 'transcribe',
              stage: 'process'
            }
          )
        )
      }
    })
    child.once('error', (cause) => {
      finish(
        new ProviderError('PROCESS_FAILED', 'The local transcription process could not start', {
          providerKind: 'local-cli',
          operation: 'transcribe',
          stage: 'process',
          cause
        })
      )
    })
    child.once('close', (code) => {
      if (settled) return
      if (pendingError) {
        finish(pendingError)
      } else if (overflow) {
        finish(
          new ProviderError('OUTPUT_INVALID', 'The process produced too much output', {
            providerKind: 'local-cli',
            operation: 'transcribe',
            stage: 'process'
          })
        )
      } else if (code !== 0) {
        finish(
          new ProviderError(
            'PROCESS_FAILED',
            `The local transcription process exited with code ${code ?? 'unknown'}`,
            {
              providerKind: 'local-cli',
              operation: 'transcribe',
              stage: 'process',
              ...(code === null ? {} : { exitCode: code })
            }
          )
        )
      } else {
        finish()
      }
    })
  })
}

async function readBoundedOutputFile(path: string, providerKind: string): Promise<string> {
  const details = await stat(path)
  if (!details.isFile() || details.size > MAX_PROCESS_OUTPUT_BYTES) {
    throw new ProviderError('OUTPUT_INVALID', 'The local transcription output file is invalid', {
      providerKind,
      operation: 'transcribe',
      stage: 'parse'
    })
  }
  return readFile(path, 'utf8')
}

function cancelledError(cause?: unknown): ProviderError {
  return new ProviderError('CANCELLED', 'The local transcription process was cancelled', {
    providerKind: 'local-cli',
    operation: 'transcribe',
    stage: 'process',
    ...(cause === undefined ? {} : { cause })
  })
}

function outputFileName(format: LocalCliTranscriptionProfileV1['outputFormat']): string {
  return format === 'text' ? 'transcript.txt' : 'transcript.json'
}
