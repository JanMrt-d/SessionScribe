import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '@main/artifacts/ArtifactStore'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('ArtifactStore', () => {
  it('copies imports into an isolated session directory and blocks traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-artifacts-'))
    directories.push(root)
    const source = join(root, 'source.mp4')
    await writeFile(source, 'fixture')
    const store = new ArtifactStore(join(root, 'videos'))
    await store.initialize()
    const sessionId = randomUUID()
    const imported = await store.importMedia(sessionId, source)
    expect(imported).toContain(sessionId)
    expect(() => store.pathFor(sessionId, '..', '..', 'escape')).toThrow(/escapes/)
    expect(() => store.assertSessionPath(sessionId, source)).toThrow(/escapes/)
  })

  it('supports non-existent destinations below a canonical session directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-artifacts-'))
    directories.push(root)
    const store = new ArtifactStore(join(root, 'videos'))
    await store.initialize()
    const sessionId = randomUUID()
    await store.ensureSession(sessionId)

    const destination = store.pathFor(sessionId, 'work', 'nested', 'result.json')
    await store.atomicJson(destination, { status: 'ready' })

    await expect(store.readJson(destination)).resolves.toEqual({ status: 'ready' })
  })

  it('rejects a session directory symlink that escapes the artifact root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-artifacts-'))
    directories.push(root)
    const outside = join(root, 'outside')
    await mkdir(outside)
    const store = new ArtifactStore(join(root, 'videos'))
    await store.initialize()
    const sessionId = randomUUID()
    const sessionDirectory = store.sessionDirectory(sessionId)
    await symlink(outside, sessionDirectory, directoryLinkType())

    expect(() => store.pathFor(sessionId, 'work', 'audio.flac')).toThrow(/escapes/)
    await expect(store.ensureSession(sessionId)).rejects.toThrow(/escapes/)
  })

  it('rejects a work directory symlink that escapes its session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-artifacts-'))
    directories.push(root)
    const outside = join(root, 'outside')
    await mkdir(outside)
    const store = new ArtifactStore(join(root, 'videos'))
    await store.initialize()
    const sessionId = randomUUID()
    await store.ensureSession(sessionId)
    const workDirectory = join(store.sessionDirectory(sessionId), 'work')
    await rm(workDirectory, { recursive: true })
    await symlink(outside, workDirectory, directoryLinkType())

    expect(() => store.pathFor(sessionId, 'work', 'audio.flac')).toThrow(/escapes/)
    await expect(store.atomicJson(join(workDirectory, 'result.json'), {})).rejects.toThrow(
      /escapes/
    )
  })

  it('rejects a session symlink that aliases another session inside the artifact root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sessionscribe-artifacts-'))
    directories.push(root)
    const store = new ArtifactStore(join(root, 'videos'))
    await store.initialize()
    const firstSessionId = randomUUID()
    const secondSessionId = randomUUID()
    await store.ensureSession(secondSessionId)
    await symlink(
      store.sessionDirectory(secondSessionId),
      store.sessionDirectory(firstSessionId),
      directoryLinkType()
    )

    expect(() => store.pathFor(firstSessionId, 'work', 'audio.flac')).toThrow(/escapes/)
  })
})

function directoryLinkType(): 'dir' | 'junction' {
  return process.platform === 'win32' ? 'junction' : 'dir'
}
