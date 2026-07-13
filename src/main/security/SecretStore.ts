import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'

interface SecretFile {
  version: 1
  values: Record<string, string>
}

export class SecretStore {
  private readonly memory = new Map<string, string>()
  private file: SecretFile = { version: 1, values: {} }
  private loadPromise: Promise<void> | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  isPersistentEncryptionAvailable(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform === 'linux')
      return safeStorage.getSelectedStorageBackend() !== 'basic_text'
    return true
  }

  async put(reference: string, value: string): Promise<void> {
    validateReference(reference)
    if (!value) {
      await this.delete(reference)
      return
    }
    if (!this.isPersistentEncryptionAvailable()) {
      this.memory.set(reference, value)
      return
    }
    await this.enqueueMutation(async () => {
      await this.load()
      this.file.values[reference] = safeStorage.encryptString(value).toString('base64')
      await this.flush()
    })
  }

  async get(reference: string): Promise<string | undefined> {
    validateReference(reference)
    const volatile = this.memory.get(reference)
    if (volatile !== undefined) return volatile
    if (!this.isPersistentEncryptionAvailable()) return undefined
    await this.mutationQueue
    await this.load()
    const encrypted = this.file.values[reference]
    if (!encrypted) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return undefined
    }
  }

  async delete(reference: string): Promise<void> {
    validateReference(reference)
    this.memory.delete(reference)
    if (!this.isPersistentEncryptionAvailable()) return
    await this.enqueueMutation(async () => {
      await this.load()
      delete this.file.values[reference]
      await this.flush()
    })
  }

  private async load(): Promise<void> {
    this.loadPromise ??= this.loadFromDisk()
    await this.loadPromise
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as SecretFile
      if (parsed.version === 1 && parsed.values && typeof parsed.values === 'object')
        this.file = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.catch(() => undefined)
    await result
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(this.file), { mode: 0o600 })
    await rename(temporary, this.filePath)
  }
}

function validateReference(reference: string): void {
  if (!/^[a-z0-9][a-z0-9._:/-]{2,240}$/i.test(reference))
    throw new Error('Invalid secret reference')
}
