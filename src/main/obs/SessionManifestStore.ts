import { randomUUID } from 'node:crypto'
import { open, readFile, rename, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

import { captureConfigurationSchema } from '@shared/capture'

import { ObsSubsystemError } from './errors'
import type { SessionManifest } from './types'

const manifestSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  state: z.enum([
    'configuring',
    'ready',
    'start-intent',
    'recording',
    'stop-intent',
    'finalizing',
    'complete',
    'interrupted',
    'failed'
  ]),
  recordDirectory: z.string().min(1),
  outputPaths: z.array(z.string()),
  profileName: z.string().min(1),
  sceneCollectionName: z.string().min(1),
  previousProfileName: z.string().nullable(),
  previousSceneCollectionName: z.string().nullable(),
  platform: z.enum(['windows', 'x11', 'wayland']),
  configuration: captureConfigurationSchema,
  windowInputUuid: z.string().min(1),
  microphoneInputUuid: z.string().nullable(),
  systemAudioInputUuid: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  stopRequestedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  lastDurationMs: z.number().int().nonnegative(),
  lastBytes: z.number().int().nonnegative(),
  error: z.string().nullable(),
  updatedAt: z.string().datetime()
})

export class SessionManifestStore {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  async load(): Promise<SessionManifest | null> {
    await this.writeTail
    try {
      return manifestSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new ObsSubsystemError(
          'OBS_MANIFEST_INVALID',
          'The active recording manifest is invalid',
          error
        )
      }
      throw error
    }
  }

  save(manifest: SessionManifest): Promise<SessionManifest> {
    const value = manifestSchema.parse(manifest)
    return this.enqueueWrite(async () => {
      await this.write(value)
      return value
    })
  }

  remove(): Promise<void> {
    return this.enqueueWrite(async () => rm(this.path, { force: true }))
  }

  private async write(value: SessionManifest): Promise<void> {
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
