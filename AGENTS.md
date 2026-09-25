# SessionScribe Engineering Guide

Electron, React, and TypeScript desktop app. Linux only. Node.js 24 (`.nvmrc`);
FFmpeg and FFprobe must be on `PATH` for the integration tests.

## Commands

- Install: `npm ci`
- Develop: `npm run dev`
- Type-check: `npm run typecheck`
- Lint: `npm run lint`
- Format check: `npm run format:check` (fix with `npm run format`)
- Unit tests: `npm test` (single file: `npx vitest run <path>`)
- Integration tests: `npm run test:integration`
- Electron end-to-end tests: `npm run test:e2e` (headless: `xvfb-run -a npm run test:e2e`)
- Production build: `npm run build` (includes the type-check)

## Boundaries

- `src/main` owns the filesystem, database, subprocesses, OBS, network providers, secrets, and the managed Docker runtimes (Whisper on Vulkan, diarization on ROCm).
- `src/preload` exposes only the typed `SessionScribeApi` contract.
- `src/renderer` has no Node.js access and never receives credentials or unrestricted paths.
- `src/shared` contains versioned Zod schemas and IPC types. Changes here ripple across every process. Never alter a released document version in place; add a new version and upgrade stored documents on read.
- Keep provider-specific wire formats behind adapters; persist only canonical documents.
- Never log transcripts, summaries, provider payloads, credentials, or OBS passwords.

## Security Invariants

Read the Security Invariants in `ARCHITECTURE.md` before touching providers, subprocesses, paths, or Docker. In short: remote provider HTTP is rejected (HTTPS or loopback HTTP only); OBS is loopback-only; subprocesses use fixed executables, separate `argv` entries, and `shell: false`; paths are confined through real filesystem ancestors, including across symlinks; managed containers are image-pinned, loopback-only, mount models read-only, and never mount the Docker socket.

## Tests

OBS tests must use the v5 protocol fake in `test/fake-obs` rather than mocked gateway methods. Provider tests must use local fixture servers and must not require paid credentials. Managed-runtime tests must use fake Docker runners; nothing in the test suites may require a GPU or a running Docker daemon. A bug fix comes with a test that fails without the fix.

## Verification

Before considering a change complete, run what CI runs: type-check, lint, format check, unit tests, integration tests, production build, and end-to-end tests. For changes to packaging, `extraResources`, or anything reading `process.resourcesPath`, also run `npm run package:linux` followed by `npm run test:e2e:packaged:linux`.

## Conventions

- Use conventional commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`) and keep one logical change per commit.
- Deferred upgrades: TypeScript 7 waits for a `typescript-eslint` release that accepts it; Vite 8 and `@vitejs/plugin-react` 6 wait for an `electron-vite` release that accepts Vite 8. Do not apply them piecemeal.
