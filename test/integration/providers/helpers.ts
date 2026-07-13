import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { ProviderContext, SecretStore } from '@main/providers'
import type { TranscriptDocumentV1 } from '@shared/transcript'

export const timestamp = '2026-01-01T00:00:00.000Z'

export function providerContext(secrets: Readonly<Record<string, string>> = {}): ProviderContext {
  const store: SecretStore = {
    get: (reference) => Promise.resolve(secrets[reference])
  }
  return {
    signal: new AbortController().signal,
    secrets: store,
    now: () => new Date(timestamp)
  }
}

export interface FixtureServer {
  baseUrl: string
  close: () => Promise<void>
}

export async function startFixtureServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close()
      await once(server, 'close')
    }
  }
}

export async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('Expected a binary request body')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export function transcriptFixture(text = 'Alice owns the release task.'): TranscriptDocumentV1 {
  const sessionId = randomUUID()
  return {
    schemaVersion: 1,
    id: randomUUID(),
    sessionId,
    revision: 1,
    sourceSha256: 'fixture-sha',
    durationMs: 2_000,
    text,
    languages: ['en'],
    speakers: [{ id: 'speaker-1', label: 'Speaker 1', displayName: 'Alice' }],
    words: [],
    utterances: [
      {
        id: 'utterance-1',
        text,
        startMs: 100,
        endMs: 1_900,
        speakerId: 'speaker-1',
        wordIds: [],
        manuallyEdited: false
      }
    ],
    warnings: [],
    provenance: {
      providerKind: 'fixture',
      model: 'fixture-model',
      generatedAt: timestamp
    }
  }
}

export function profileBase(model: string) {
  return {
    id: randomUUID(),
    name: 'Fixture provider',
    model,
    timeoutMs: 5_000,
    secretRefs: {},
    extraHeaders: {},
    createdAt: timestamp,
    updatedAt: timestamp
  }
}
