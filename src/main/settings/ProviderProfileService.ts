import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { providerProfileSchema, type ProviderProfileV1 } from '@shared/index'
import type { AppDatabase } from '../persistence/Database'
import { httpCredentialOptionsFor, validateHttpHeaderConfiguration } from '../providers/security'
import type { SecretStore } from '../security/SecretStore'

export class ProviderProfileService {
  constructor(
    private readonly database: AppDatabase,
    private readonly secrets: SecretStore
  ) {}

  async initializeDefaults(): Promise<void> {
    if (this.database.listProviderProfiles().length > 0) return
    const now = new Date().toISOString()
    const profiles: ProviderProfileV1[] = [
      {
        id: randomUUID(),
        name: 'ElevenLabs Scribe v2',
        task: 'transcription',
        kind: 'elevenlabs',
        model: 'scribe_v2',
        baseUrl: 'https://api.elevenlabs.io/v1',
        timeoutMs: 2_700_000,
        secretRefs: {},
        extraHeaders: {},
        language: null,
        diarize: true,
        numSpeakers: null,
        timestampGranularity: 'word',
        createdAt: now,
        updatedAt: now
      },
      {
        id: randomUUID(),
        name: 'OpenAI summary',
        task: 'summary',
        kind: 'openai-compatible',
        model: 'gpt-5.6-terra',
        baseUrl: 'https://api.openai.com/v1',
        timeoutMs: 300_000,
        secretRefs: {},
        extraHeaders: {},
        apiStyle: 'responses',
        structuredOutput: 'json-schema',
        contextWindowTokens: 1_000_000,
        extraBody: {},
        meetingPromptOverride: null,
        lecturePromptOverride: null,
        createdAt: now,
        updatedAt: now
      }
    ]
    profiles.forEach((profile) => this.database.saveProviderProfile(profile))
  }

  list(): ProviderProfileV1[] {
    return this.database.listProviderProfiles()
  }

  ensureManagedWhisperDefault(): ProviderProfileV1 {
    const existing = this.list().find((profile) => profile.kind === 'managed-whisper')
    if (existing) return existing
    const now = new Date().toISOString()
    return this.database.saveProviderProfile({
      id: randomUUID(),
      name: 'Managed Whisper Large-v3',
      task: 'transcription',
      kind: 'managed-whisper',
      model: 'large-v3',
      timeoutMs: 3_600_000,
      secretRefs: {},
      extraHeaders: {},
      language: null,
      createdAt: now,
      updatedAt: now
    })
  }

  validate(
    profile: ProviderProfileV1,
    secretNames: readonly string[] = [],
    secretValues: Readonly<Record<string, string>> = {}
  ): void {
    validateEndpoint(profile)
    const configuredSecretNames = [...new Set([...Object.keys(profile.secretRefs), ...secretNames])]
    if (profile.kind === 'local-cli') {
      if (!isAbsolute(profile.executable)) {
        throw new Error('The local CLI executable must use an absolute path')
      }
      if (Object.keys(profile.extraHeaders).length > 0) {
        throw new Error('HTTP headers cannot be configured for a local CLI')
      }
      if (!profile.args.some((argument) => argument.includes('{input}'))) {
        throw new Error('Local CLI arguments require an {input} placeholder')
      }
      if (
        profile.outputMode === 'file' &&
        !profile.args.some((argument) => argument.includes('{output}'))
      ) {
        throw new Error('File output requires an {output} argument placeholder')
      }
      for (const name of configuredSecretNames) {
        if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new Error('Local CLI secrets must use env:VARIABLE names')
        }
      }
      return
    }
    if (profile.kind === 'claude-cli') {
      if (!isAbsolute(profile.executable)) {
        throw new Error('The agent CLI executable must use an absolute path')
      }
      if (Object.keys(profile.extraHeaders).length > 0) {
        throw new Error('HTTP headers cannot be configured for a local CLI')
      }
      for (const name of configuredSecretNames) {
        if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new Error('Local CLI secrets must use env:VARIABLE names')
        }
      }
      return
    }
    if (profile.kind === 'managed-whisper') {
      if (Object.keys(profile.extraHeaders).length > 0 || configuredSecretNames.length > 0) {
        throw new Error('Managed Whisper does not accept HTTP headers or credentials')
      }
      return
    }
    validateHttpHeaderConfiguration(
      profile.extraHeaders,
      configuredSecretNames,
      httpCredentialOptionsFor(profile),
      secretValues
    )
  }

  async save(
    profileInput: ProviderProfileV1,
    secretValues: Record<string, string>
  ): Promise<ProviderProfileV1> {
    this.validate(profileInput, Object.keys(secretValues), secretValues)
    const now = new Date().toISOString()
    const existing = this.database.getProviderProfile(profileInput.id)
    const credentialScopeChanged = Boolean(
      existing && providerCredentialScopeChanged(existing, profileInput)
    )
    const suppliedSecretNames = Object.entries(secretValues)
      .filter(([, value]) => value.length > 0)
      .map(([name]) => name)
    const desiredSecretNames = new Set([
      ...(credentialScopeChanged ? [] : Object.keys(profileInput.secretRefs)),
      ...suppliedSecretNames
    ])
    const secretRefs: Record<string, string> = {}
    for (const name of desiredSecretNames) validateSecretName(name)

    for (const [name, reference] of Object.entries(existing?.secretRefs ?? {})) {
      if (credentialScopeChanged || !desiredSecretNames.has(name)) {
        await this.secrets.delete(reference)
      }
    }
    for (const name of desiredSecretNames) {
      const reference = providerSecretReference(profileInput.id, name)
      const previousReference = credentialScopeChanged ? undefined : existing?.secretRefs[name]
      const value = secretValues[name]
      if (value) {
        await this.secrets.put(reference, value)
      } else if (previousReference && previousReference !== reference) {
        const previousValue = await this.secrets.get(previousReference)
        if (previousValue) await this.secrets.put(reference, previousValue)
      }
      if (previousReference && previousReference !== reference) {
        await this.secrets.delete(previousReference)
      }
      secretRefs[name] = reference
    }
    const profile = providerProfileSchema.parse({ ...profileInput, secretRefs, updatedAt: now })
    return this.database.saveProviderProfile(profile)
  }

  async resolveSecrets(profile: ProviderProfileV1): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {}
    for (const [name, reference] of Object.entries(profile.secretRefs)) {
      const value = await this.secrets.get(reference)
      if (value) resolved[name] = value
    }
    return resolved
  }

  async delete(id: string): Promise<void> {
    const profile = this.database.getProviderProfile(id)
    if (!profile) return
    await Promise.all(
      Object.values(profile.secretRefs).map((reference) => this.secrets.delete(reference))
    )
    this.database.deleteProviderProfile(id)
  }
}

export function providerSecretReference(profileId: string, name: string): string {
  validateSecretName(name)
  return `provider/${profileId}/${name}`
}

function validateSecretName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/.test(name)) {
    throw new Error(
      'Provider secret names may contain letters, numbers, dots, colons, dashes, and underscores'
    )
  }
}

function validateEndpoint(profile: ProviderProfileV1): void {
  if (!('baseUrl' in profile)) return
  const url = new URL(profile.baseUrl)
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Provider endpoints must use HTTPS; HTTP is allowed only on loopback')
  }
  if (url.username || url.password) throw new Error('Provider URL must not contain credentials')
}

function providerCredentialScopeChanged(
  existing: ProviderProfileV1,
  replacement: ProviderProfileV1
): boolean {
  return (
    existing.kind !== replacement.kind ||
    normalizedEndpointOrigin(existing) !== normalizedEndpointOrigin(replacement)
  )
}

function normalizedEndpointOrigin(profile: ProviderProfileV1): string | null {
  return 'baseUrl' in profile ? new URL(profile.baseUrl).origin : null
}
