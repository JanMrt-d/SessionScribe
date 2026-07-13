import { constants, realpathSync } from 'node:fs'
import { access, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve
} from 'node:path'
import { randomUUID } from 'node:crypto'

export class ArtifactStore {
  readonly root: string
  private canonicalRoot: string | null = null

  constructor(videosDirectory: string) {
    this.root = resolve(videosDirectory, 'SessionScribe')
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    this.canonicalRoot = canonicalPath(this.root)
  }

  sessionDirectory(sessionId: string): string {
    assertUuid(sessionId)
    return join(this.root, sessionId)
  }

  async ensureSession(sessionId: string): Promise<string> {
    const directory = this.sessionDirectory(sessionId)
    const workDirectory = this.pathFor(sessionId, 'work')
    const exportsDirectory = this.pathFor(sessionId, 'exports')
    await mkdir(workDirectory, { recursive: true })
    await mkdir(exportsDirectory, { recursive: true })
    this.assertSessionPath(sessionId, workDirectory)
    this.assertSessionPath(sessionId, exportsDirectory)
    return directory
  }

  async importMedia(sessionId: string, sourcePath: string): Promise<string> {
    if (!isAbsolute(sourcePath)) throw new Error('Imported media path must be absolute')
    await access(sourcePath, constants.R_OK)
    await this.ensureSession(sessionId)
    const extension = safeExtension(sourcePath)
    const destination = this.pathFor(sessionId, `recording-imported${extension}`)
    await copyFile(sourcePath, destination)
    return destination
  }

  pathFor(sessionId: string, ...segments: string[]): string {
    const directory = this.sessionDirectory(sessionId)
    const candidate = resolve(directory, ...segments)
    this.assertSessionContained(candidate, directory)
    return candidate
  }

  assertSessionPath(sessionId: string, candidate: string): string {
    const directory = this.sessionDirectory(sessionId)
    const resolved = resolve(candidate)
    this.assertSessionContained(resolved, directory)
    return resolved
  }

  async atomicJson(path: string, value: unknown): Promise<void> {
    const resolved = resolve(path)
    this.assertStoreContained(resolved)
    await mkdir(dirname(resolved), { recursive: true })
    this.assertStoreContained(resolved)
    const temporary = `${resolved}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, resolved)
  }

  async readJson<T>(path: string): Promise<T | null> {
    const resolved = resolve(path)
    this.assertStoreContained(resolved)
    try {
      return JSON.parse(await readFile(resolved, 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async waitForStableFile(path: string, delayMs = 500): Promise<void> {
    const resolved = resolve(path)
    this.assertStoreContained(resolved)
    let previous = await stat(resolved)
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
      const current = await stat(resolved)
      if (
        current.size === previous.size &&
        current.mtimeMs === previous.mtimeMs &&
        current.size > 0
      )
        return
      previous = current
    }
    throw new Error(`Recording did not stabilize: ${basename(path)}`)
  }

  async removeWorkFiles(sessionId: string): Promise<void> {
    const workDirectory = this.pathFor(sessionId, 'work')
    await rm(workDirectory, { recursive: true, force: true })
    await mkdir(workDirectory, { recursive: true })
    this.assertSessionPath(sessionId, workDirectory)
  }

  async removeSession(sessionId: string): Promise<void> {
    const directory = this.sessionDirectory(sessionId)
    this.assertStoreContained(directory)
    await rm(directory, { recursive: true, force: true })
  }

  private assertSessionContained(candidate: string, directory: string): void {
    const root = this.canonicalRoot ?? canonicalPath(this.root)
    const expectedDirectory = resolve(root, basename(directory))
    const canonicalDirectory = this.assertStoreContained(directory)
    if (canonicalDirectory !== expectedDirectory) {
      throw new Error('Path escapes the SessionScribe session directory')
    }
    this.assertCanonicalContained(canonicalPath(candidate), expectedDirectory)
  }

  private assertStoreContained(candidate: string): string {
    const canonicalCandidate = canonicalPath(candidate)
    const root = this.canonicalRoot ?? canonicalPath(this.root)
    this.assertCanonicalContained(canonicalCandidate, root)
    return canonicalCandidate
  }

  private assertCanonicalContained(candidate: string, root: string): void {
    const relation = relative(root, normalize(candidate))
    if (relation.startsWith('..') || isAbsolute(relation)) {
      throw new Error('Path escapes the SessionScribe data directory')
    }
  }
}

function canonicalPath(path: string): string {
  let existingAncestor = resolve(path)
  const missingSegments: string[] = []

  for (;;) {
    try {
      return resolve(realpathSync.native(existingAncestor), ...missingSegments)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(existingAncestor)
      if (parent === existingAncestor) throw error
      missingSegments.unshift(basename(existingAncestor))
      existingAncestor = parent
    }
  }
}

function safeExtension(path: string): string {
  const extension = extname(path).toLowerCase()
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) return '.media'
  return extension
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Invalid session identifier')
  }
}
