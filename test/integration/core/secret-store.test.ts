import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'secret_service',
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}))

import { SecretStore } from '@main/security/SecretStore'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SecretStore', () => {
  it('serializes parallel persistent mutations across a cold load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-secrets-'))
    directories.push(root)
    const path = join(root, 'secrets.json')
    const initial = new SecretStore(path)
    const references = Array.from({ length: 16 }, (_, index) => `provider/profile/key-${index}`)
    for (const reference of references) await initial.put(reference, `value:${reference}`)

    const reopened = new SecretStore(path)
    await Promise.all(references.map((reference) => reopened.delete(reference)))

    const verified = new SecretStore(path)
    await expect(
      Promise.all(references.map((reference) => verified.get(reference)))
    ).resolves.toEqual(references.map(() => undefined))
  })
})
