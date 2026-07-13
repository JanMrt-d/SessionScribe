import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { ObsSubsystemError } from './errors'

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

async function canonicalIfPresent(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

export async function confineOutputPath(
  rootDirectory: string,
  candidatePath: string
): Promise<string> {
  const canonicalRoot = await canonicalIfPresent(rootDirectory)
  const candidate = isAbsolute(candidatePath)
    ? candidatePath
    : resolve(canonicalRoot, candidatePath)
  const canonicalCandidate = await canonicalIfPresent(candidate)

  if (!isWithin(canonicalRoot, canonicalCandidate)) {
    throw new ObsSubsystemError(
      'OBS_OUTPUT_PATH_OUTSIDE_SESSION',
      'OBS returned an output path outside the active session directory'
    )
  }

  return canonicalCandidate
}

export async function stableFile(
  path: string,
  wait: (ms: number) => Promise<void>,
  intervalMs = 500
): Promise<{ path: string; size: number } | null> {
  try {
    const first = await stat(path)
    if (!first.isFile() || first.size <= 0) return null
    await wait(intervalMs)
    const second = await stat(path)
    if (!second.isFile() || first.size !== second.size || first.mtimeMs !== second.mtimeMs)
      return null
    return { path, size: second.size }
  } catch {
    return null
  }
}
