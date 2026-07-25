# Contributing to SessionScribe

Thanks for taking the time. This document covers the setup, the architectural
rules that pull requests are reviewed against, and the verification a change
needs before it can land.

## Getting Started

```bash
npm ci
npm run dev
```

You need Node.js 24 (see `.nvmrc`), plus FFmpeg and FFprobe on `PATH`. OBS
Studio 32.x with the WebSocket server enabled is only required to work on
recording; imports, transcription, and summarization all work without it.

The managed local runtimes are optional for development and Linux-only. Nothing
in the test suites requires a GPU or a running Docker daemon.

## Process Boundaries

These are hard rules, not style preferences. A change that crosses them will be
asked to move code rather than widen the boundary.

- `src/main` owns the filesystem, database, subprocesses, OBS, network
  providers, secrets, and the managed Docker runtimes (Whisper on Vulkan,
  diarization on ROCm).
- `src/preload` exposes only the typed `SessionScribeApi` contract.
- `src/renderer` has no Node.js access and never receives credentials or
  unrestricted paths.
- `src/shared` contains versioned Zod schemas and IPC types. Changes here ripple
  across every process, so they get extra scrutiny.
- Keep provider-specific wire formats behind adapters; persist only canonical
  documents.
- Never log transcripts, summaries, provider payloads, credentials, or OBS
  passwords.

[ARCHITECTURE.md](ARCHITECTURE.md) explains the durable pipeline, the OBS
recording lifecycle, the managed runtime leases, and the security invariants
those rules protect.

## Testing Rules

- **OBS tests** must drive the v5 protocol fake in `test/fake-obs`, not mocked
  gateway methods. The fake is where protocol-level regressions get caught.
- **Provider tests** must use local fixture servers. No test may require paid
  credentials or reach a real provider.
- **Managed-runtime tests** must use fake Docker runners. No test may require a
  GPU or a running Docker daemon.

If a bug is worth fixing, it is worth a test that fails without the fix. Verify
that directly — stash the fix, watch the test fail, restore it.

## Verification

Run all of these before opening a pull request. CI runs the same gates on Linux
and Windows.

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
npm run test:e2e
```

For changes that touch packaging, `extraResources`, or anything reading
`process.resourcesPath`, also build and smoke-test the real artifact — the
packaged path differs from the dev path and only the packaged run exercises it:

```bash
npm run package:linux
npm run test:e2e:packaged:linux
```

## Commits and Pull Requests

Write commit messages that explain what changed and why, not just what file
moved. Use a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`,
`refactor:`, `test:`) and keep one logical change per commit.

In the pull request, describe the user-visible effect, the verification you
ran, and anything you deliberately left out of scope.

## Reporting Bugs

Open an issue with the platform, the application version, and the steps to
reproduce. Please do not paste transcripts, summaries, or provider payloads into
an issue — redact anything you would not publish. Security problems go through
[SECURITY.md](SECURITY.md) instead.
