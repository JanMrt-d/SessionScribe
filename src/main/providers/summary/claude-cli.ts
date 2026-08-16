import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { ProviderCapabilities } from '@shared/providers'
import type { ProviderContext, SummaryAdapter, SummaryRequest } from '../contracts'
import { ProviderError, normalizeProviderError } from '../errors'
import { createGroundedSummary, type SummaryTextGenerator } from './engine'
import type { ClaudeCliSummaryProfileV1 } from './types'

const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROVIDER_KIND = 'claude-cli'

/**
 * Summarizes through a locally installed agent CLI, which lets an existing
 * Claude Code login supply the model instead of a separate API credential.
 *
 * The trade-off is deliberate and visible in `capabilities()`: the CLI exposes no
 * response-schema parameter, so this adapter is prompt-only. The grounding
 * contract is enforced after the fact by the shared summary engine, which parses
 * the returned JSON, checks every evidence ID against the utterances that were
 * actually shown, and re-prompts once with a repair instruction before failing.
 */
export class ClaudeCliSummaryAdapter implements SummaryAdapter<ClaudeCliSummaryProfileV1> {
  readonly kind = 'claude-cli' as const

  capabilities(): ProviderCapabilities {
    return {
      timestamps: false,
      diarization: false,
      // The CLI has no schema-enforcement flag; the engine validates instead.
      structuredOutput: false,
      modelListing: false,
      maxInputBytes: null,
      maxDurationMs: null
    }
  }

  async summarize(
    request: SummaryRequest,
    profile: ClaudeCliSummaryProfileV1,
    context: ProviderContext
  ) {
    try {
      validateProfile(profile)
      const environment = await resolveEnvironment(profile, context)
      const generate: SummaryTextGenerator = async (generation) => {
        const carriesSystemPrompt = profile.args.some((argument) => argument.includes('{system}'))
        const args = profile.args.map((argument) =>
          substituteArgument(argument, {
            model: profile.model,
            system: generation.systemPrompt
          })
        )
        // Without a {system} placeholder the grounding rules would never reach the
        // model, so they are prepended to the stdin payload instead of dropped.
        const stdin = carriesSystemPrompt
          ? generation.userPrompt
          : `${generation.systemPrompt}\n\n${generation.userPrompt}`
        const stdout = await executeProcess(
          profile.executable,
          args,
          stdin,
          environment,
          profile.timeoutMs,
          context
        )
        return profile.outputEnvelope === 'claude-json' ? unwrapClaudeEnvelope(stdout) : stdout
      }
      return await createGroundedSummary(request, context, {
        providerKind: this.kind,
        model: profile.model,
        contextWindowTokens: profile.contextWindowTokens,
        promptOverride:
          request.mode === 'meeting'
            ? profile.meetingPromptOverride
            : profile.lecturePromptOverride,
        generate
      })
    } catch (error) {
      throw normalizeProviderError(error, {
        providerKind: this.kind,
        operation: 'summarize',
        stage: 'process'
      })
    }
  }
}

/**
 * Reads the text the model produced out of `claude -p --output-format json`,
 * whose envelope wraps the answer in a result record rather than returning it
 * directly. A CLI-reported failure carries its message in the same `result`
 * field, so `is_error` is checked before the value is trusted.
 */
export function unwrapClaudeEnvelope(stdout: string): string {
  let parsed: unknown
  try {
    const value: unknown = JSON.parse(stdout.trim())
    parsed = value
  } catch (cause) {
    throw outputError('The agent CLI did not return JSON output', cause)
  }
  // `--output-format stream-json` emits an array whose last entry is the result.
  const envelope: unknown = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw outputError('The agent CLI returned an unexpected JSON shape')
  }
  const record = envelope as Record<string, unknown>
  if (record.is_error === true) {
    throw new ProviderError('PROCESS_FAILED', 'The agent CLI reported an error', {
      providerKind: PROVIDER_KIND,
      operation: 'summarize',
      stage: 'process'
    })
  }
  const result = record.result
  if (typeof result !== 'string' || !result.trim()) {
    throw outputError('The agent CLI response did not contain generated text')
  }
  return result
}

function validateProfile(profile: ClaudeCliSummaryProfileV1): void {
  if (!isAbsolute(profile.executable)) {
    throw configError('The agent CLI executable must use an absolute path')
  }
  if (Object.keys(profile.extraHeaders).length > 0) {
    throw configError('HTTP headers cannot be configured for a local CLI')
  }
}

async function resolveEnvironment(
  profile: ClaudeCliSummaryProfileV1,
  context: ProviderContext
): Promise<NodeJS.ProcessEnv> {
  // An inherited environment is the norm here rather than the exception: the CLI
  // finds an existing subscription login through the user's own HOME and config.
  const environment: NodeJS.ProcessEnv = profile.inheritEnvironment
    ? { ...process.env }
    : pickEnvironment(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'PATH', 'USERPROFILE'])
  for (const [key, reference] of Object.entries(profile.secretRefs)) {
    if (!key.startsWith('env:')) {
      throw configError(`Unsupported CLI secret reference key: ${key}`)
    }
    const name = key.slice('env:'.length)
    if (!ENVIRONMENT_NAME.test(name)) {
      throw configError('A CLI environment variable name is invalid')
    }
    const value = await context.secrets.get(reference, context.signal)
    if (!value) {
      throw new ProviderError('SECRET_MISSING', 'A configured CLI secret is unavailable', {
        providerKind: PROVIDER_KIND,
        operation: 'summarize',
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
  return argument.replace(/\{(model|system)\}/g, (_match, name: string) => values[name] ?? '')
}

function executeProcess(
  executable: string,
  args: readonly string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  context: ProviderContext
): Promise<string> {
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
      stdio: ['pipe', 'pipe', 'pipe']
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
      else resolve(Buffer.concat(stdout).toString('utf8'))
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
        new ProviderError('TIMEOUT', 'The agent CLI process timed out', {
          providerKind: PROVIDER_KIND,
          operation: 'summarize',
          stage: 'process',
          retryable: true
        })
      )
    }, timeoutMs)
    context.signal.addEventListener('abort', onAbort, { once: true })

    // A CLI that exits before reading the prompt makes the pipe write fail; that
    // is reported through the exit code below, so the EPIPE itself is swallowed.
    child.stdin.on('error', () => undefined)
    child.stdin.end(stdin, 'utf8')

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) {
        overflow = true
        stop(outputError('The agent CLI produced too much output'))
      } else {
        stdout.push(chunk)
      }
    })
    // stderr is measured but never captured: it can echo prompt content, which
    // must not reach a summary error message or the logs.
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) {
        overflow = true
        stop(outputError('The agent CLI produced too much output'))
      }
    })
    child.once('error', (cause) => {
      finish(
        new ProviderError('PROCESS_FAILED', 'The agent CLI process could not start', {
          providerKind: PROVIDER_KIND,
          operation: 'summarize',
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
        finish(outputError('The agent CLI produced too much output'))
      } else if (code !== 0) {
        finish(
          new ProviderError(
            'PROCESS_FAILED',
            `The agent CLI exited with code ${code ?? 'unknown'}`,
            {
              providerKind: PROVIDER_KIND,
              operation: 'summarize',
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

function configError(message: string): ProviderError {
  return new ProviderError('INVALID_CONFIG', message, {
    providerKind: PROVIDER_KIND,
    operation: 'summarize',
    stage: 'preflight'
  })
}

function outputError(message: string, cause?: unknown): ProviderError {
  return new ProviderError('OUTPUT_INVALID', message, {
    providerKind: PROVIDER_KIND,
    operation: 'summarize',
    stage: 'parse',
    ...(cause === undefined ? {} : { cause })
  })
}

function cancelledError(cause?: unknown): ProviderError {
  return new ProviderError('CANCELLED', 'The agent CLI process was cancelled', {
    providerKind: PROVIDER_KIND,
    operation: 'summarize',
    stage: 'process',
    ...(cause === undefined ? {} : { cause })
  })
}
