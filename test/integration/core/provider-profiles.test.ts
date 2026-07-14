import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderProfileV1 } from '@shared/providers'
import { AppDatabase } from '@main/persistence/Database'
import {
  ProviderProfileService,
  providerSecretReference
} from '@main/settings/ProviderProfileService'
import type { SecretStore } from '@main/security/SecretStore'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('provider profile secrets', () => {
  it('canonicalizes renderer-provided references and removes only profile-owned secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-profiles-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const values = new Map([['obs/websocket-password', 'must-remain']])
    const secrets = {
      get: async (reference: string) => values.get(reference),
      put: async (reference: string, value: string) => {
        values.set(reference, value)
      },
      delete: async (reference: string) => {
        values.delete(reference)
      }
    } as SecretStore
    const service = new ProviderProfileService(database, secrets)
    const profile = transcriptionProfile({ apiKey: 'obs/websocket-password' })

    const saved = await service.save(profile, { apiKey: 'provider-key' })
    const canonical = providerSecretReference(profile.id, 'apiKey')
    expect(saved.secretRefs).toEqual({ apiKey: canonical })
    expect(values.get(canonical)).toBe('provider-key')
    expect(values.get('obs/websocket-password')).toBe('must-remain')

    const withoutSecret = await service.save({ ...saved, secretRefs: {} }, {})
    expect(withoutSecret.secretRefs).toEqual({})
    expect(values.has(canonical)).toBe(false)
    expect(values.get('obs/websocket-password')).toBe('must-remain')
    database.close()
  })

  it('rejects local CLI profiles that cannot receive the input artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-profiles-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const secrets = {
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => undefined
    } as unknown as SecretStore
    const service = new ProviderProfileService(database, secrets)
    const now = new Date().toISOString()
    const profile: ProviderProfileV1 = {
      id: randomUUID(),
      name: 'Local transcription',
      task: 'transcription',
      kind: 'local-cli',
      model: 'local-model',
      timeoutMs: 60_000,
      secretRefs: {},
      extraHeaders: {},
      executable: process.execPath,
      args: ['--input', '{audioPath}'],
      outputMode: 'stdout',
      outputFormat: 'text',
      inheritEnvironment: false,
      createdAt: now,
      updatedAt: now
    }

    await expect(service.save(profile, {})).rejects.toThrow(/\{input\}/)
    database.close()
  })

  it('retains credentials for path changes on the same normalized endpoint origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-profiles-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const values = new Map<string, string>()
    const service = new ProviderProfileService(database, memorySecretStore(values))
    const original = transcriptionProfile({ apiKey: 'renderer-reference' })
    const saved = await service.save(original, { apiKey: 'provider-key' })

    const updated = await service.save(
      withBaseUrl(saved, 'https://API.EXAMPLE.COM:443/another/path'),
      {}
    )

    const canonical = providerSecretReference(saved.id, 'apiKey')
    expect(updated.secretRefs).toEqual({ apiKey: canonical })
    expect(values.get(canonical)).toBe('provider-key')
    database.close()
  })

  it('revokes retained credentials when the normalized endpoint origin changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-profiles-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const values = new Map<string, string>()
    const service = new ProviderProfileService(database, memorySecretStore(values))
    const original = transcriptionProfile({ apiKey: 'renderer-reference' })
    const saved = await service.save(original, { apiKey: 'provider-key' })
    const canonical = providerSecretReference(saved.id, 'apiKey')

    const updated = await service.save(withBaseUrl(saved, 'https://attacker.example/v1'), {})

    expect(updated.secretRefs).toEqual({})
    expect(values.has(canonical)).toBe(false)
    database.close()
  })

  it('revokes retained credentials when the provider kind changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-profiles-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const values = new Map<string, string>()
    const service = new ProviderProfileService(database, memorySecretStore(values))
    const original = transcriptionProfile({ apiKey: 'renderer-reference' })
    const saved = await service.save(original, { apiKey: 'provider-key' })
    const canonical = providerSecretReference(saved.id, 'apiKey')

    const updated = await service.save(elevenLabsProfile(saved), {})

    expect(updated.secretRefs).toEqual({})
    expect(values.has(canonical)).toBe(false)
    database.close()
  })

  it('stores a replacement credential when the endpoint origin changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-profiles-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const values = new Map<string, string>()
    const service = new ProviderProfileService(database, memorySecretStore(values))
    const original = transcriptionProfile({ apiKey: 'renderer-reference' })
    const saved = await service.save(original, { apiKey: 'old-provider-key' })
    const canonical = providerSecretReference(saved.id, 'apiKey')

    const updated = await service.save(withBaseUrl(saved, 'https://replacement.example/v1'), {
      apiKey: 'new-provider-key'
    })

    expect(updated.secretRefs).toEqual({ apiKey: canonical })
    expect(values.get(canonical)).toBe('new-provider-key')
    database.close()
  })

  it('applies runtime HTTP header and secret validation when saving profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-profiles-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const service = new ProviderProfileService(database, memorySecretStore(new Map()))

    await expect(
      service.save(
        { ...transcriptionProfile({}), extraHeaders: { 'Content-Type': 'application/json' } },
        {}
      )
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    await expect(
      service.save(transcriptionProfile({ clientSecret: 'renderer-reference' }), {
        clientSecret: 'secret'
      })
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    await expect(
      service.save(transcriptionProfile({ 'header:X-Tenant': 'renderer-reference' }), {
        'header:X-Tenant': 'value\r\ninjected: true'
      })
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    database.close()
  })

  it('accepts managed Whisper only without credentials or HTTP headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-profiles-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const values = new Map<string, string>()
    const service = new ProviderProfileService(database, memorySecretStore(values))
    const profile = managedWhisperProfile()

    const saved = await service.save(profile, {})
    expect(saved).toMatchObject({
      kind: 'managed-whisper',
      model: 'large-v3',
      secretRefs: {},
      extraHeaders: {}
    })
    await expect(
      service.save({ ...profile, id: randomUUID(), extraHeaders: { 'X-Tenant': 'local' } }, {})
    ).rejects.toThrow(/does not accept HTTP headers or credentials/)
    await expect(
      service.save({ ...profile, id: randomUUID(), secretRefs: { apiKey: 'renderer-ref' } }, {})
    ).rejects.toThrow(/does not accept HTTP headers or credentials/)
    await expect(
      service.save({ ...profile, id: randomUUID() }, { apiKey: 'secret-value' })
    ).rejects.toThrow(/does not accept HTTP headers or credentials/)
    expect(values.size).toBe(0)
    database.close()
  })

  it('creates the managed Whisper default once and returns it idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-profiles-'))
    directories.push(root)
    const database = new AppDatabase(join(root, 'app.db'))
    const service = new ProviderProfileService(database, memorySecretStore(new Map()))
    await service.initializeDefaults()

    const first = service.ensureManagedWhisperDefault()
    const second = service.ensureManagedWhisperDefault()
    const managedProfiles = service.list().filter((profile) => profile.kind === 'managed-whisper')

    expect(second).toEqual(first)
    expect(managedProfiles).toEqual([first])
    expect(first).toMatchObject({
      name: 'Managed Whisper Large-v3',
      task: 'transcription',
      kind: 'managed-whisper',
      model: 'large-v3',
      timeoutMs: 3_600_000,
      secretRefs: {},
      extraHeaders: {},
      language: null
    })
    expect(service.list()).toHaveLength(3)
    database.close()
  })
})

function transcriptionProfile(secretRefs: Record<string, string>): ProviderProfileV1 {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    name: 'Compatible transcription',
    task: 'transcription',
    kind: 'openai-transcription',
    model: 'any-model',
    baseUrl: 'https://api.example.com/v1',
    timeoutMs: 60_000,
    secretRefs,
    extraHeaders: {},
    language: null,
    responseFormat: 'verbose_json',
    maxUploadBytes: 25 * 1_048_576,
    createdAt: now,
    updatedAt: now
  }
}

function elevenLabsProfile(existing: ProviderProfileV1): ProviderProfileV1 {
  return {
    id: existing.id,
    name: 'ElevenLabs transcription',
    task: 'transcription',
    kind: 'elevenlabs',
    model: 'scribe_v2',
    baseUrl: 'https://api.example.com/v1',
    timeoutMs: existing.timeoutMs,
    secretRefs: existing.secretRefs,
    extraHeaders: {},
    language: null,
    diarize: true,
    numSpeakers: null,
    timestampGranularity: 'word',
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt
  }
}

function withBaseUrl(profile: ProviderProfileV1, baseUrl: string): ProviderProfileV1 {
  if (profile.kind !== 'openai-transcription') throw new Error('Unexpected fixture profile kind')
  return { ...profile, baseUrl }
}

function memorySecretStore(values: Map<string, string>): SecretStore {
  return {
    get: async (reference: string) => values.get(reference),
    put: async (reference: string, value: string) => {
      values.set(reference, value)
    },
    delete: async (reference: string) => {
      values.delete(reference)
    }
  } as SecretStore
}

function managedWhisperProfile(): ProviderProfileV1 {
  const now = new Date().toISOString()
  return {
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
  }
}
