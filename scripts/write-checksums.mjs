import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const releaseDirectory = resolve('release')
const artifactPattern = /\.(?:AppImage|rpm|exe)$/i
const artifacts = (await readdir(releaseDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && artifactPattern.test(entry.name))
  .map((entry) => entry.name)
  .sort()

if (artifacts.length === 0) throw new Error('No release installers were found')

const lines = []
for (const artifact of artifacts) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join(releaseDirectory, artifact))) hash.update(chunk)
  lines.push(`${hash.digest('hex')}  ${artifact}`)
}

await writeFile(join(releaseDirectory, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8')
process.stdout.write(`Wrote checksums for ${artifacts.length} release artifact(s)\n`)
