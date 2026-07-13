# SessionScribe Engineering Guide

## Commands

- Install: `npm ci`
- Develop: `npm run dev`
- Type-check: `npm run typecheck`
- Lint: `npm run lint`
- Unit tests: `npm test`
- Integration tests: `npm run test:integration`
- Electron end-to-end tests: `npm run test:e2e`
- Production build: `npm run build`

## Boundaries

- `src/main` owns the filesystem, database, subprocesses, OBS, network providers, and secrets.
- `src/preload` exposes only the typed `SessionScribeApi` contract.
- `src/renderer` has no Node.js access and never receives credentials or unrestricted paths.
- `src/shared` contains versioned Zod schemas and IPC types. Root owns changes to this directory.
- Keep provider-specific wire formats behind adapters; persist only canonical documents.
- Never log transcripts, summaries, provider payloads, credentials, or OBS passwords.

## Verification

Run type-check, lint, relevant tests, and a production build before considering a change complete. OBS tests must use the v5 protocol fake rather than mocked gateway methods. Provider tests must use local fixture servers and must not require paid credentials.
