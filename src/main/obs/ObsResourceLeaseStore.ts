import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

import { ObsSubsystemError } from './errors'
import type { ObsResourceRestorationLease } from './types'

const resourceLeaseSchema = z.object({
  version: z.literal(1),
  managedProfileName: z.string().min(1),
  managedSceneCollectionName: z.string().min(1),
  previousProfileName: z.string().nullable(),
  previousSceneCollectionName: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

export class ObsResourceLeaseStore {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  async load(): Promise<ObsResourceRestorationLease | null> {
    await this.writeTail
    try {
      return resourceLeaseSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new ObsSubsystemError(
          'OBS_RESOURCE_LEASE_INVALID',
          'The OBS resource restoration lease is invalid',
          error
        )
      }
      throw error
    }
  }

  save(lease: ObsResourceRestorationLease): Promise<ObsResourceRestorationLease> {
    const value = resourceLeaseSchema.parse(lease)
    return this.enqueueWrite(async () => {
      await this.write(value)
      return value
    })
  }

  remove(): Promise<void> {
    return this.enqueueWrite(async () => rm(this.path, { force: true }))
  }

  private async write(value: ObsResourceRestorationLease): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporaryPath, 'wx', 0o600)

    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    try {
      await rename(temporaryPath, this.path)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation)
    this.writeTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
