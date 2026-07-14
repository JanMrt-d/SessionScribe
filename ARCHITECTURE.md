# SessionScribe Architecture

## Process Boundaries

The Electron main process owns OBS, SQLite, files, FFmpeg children, network providers, and secrets. The sandboxed renderer has no Node.js access. A narrow preload bridge implements `SessionScribeApi`; every call is routed through a validated main-frame IPC handler.

```text
Renderer -> typed preload -> validated IPC -> application services
                                      |-> OBS WebSocket v5
                                      |-> SQLite and artifacts
                                      |-> FFmpeg/FFprobe
                                      |-> managed Docker/Whisper runtime
                                      `-> provider adapters
```

`src/shared` contains the versioned Zod schemas that cross boundaries. Provider responses are normalized into `TranscriptDocumentV1` and `SummaryDocumentV1` before persistence. Credentials and raw provider payloads never enter the renderer or database. IPC accepts only the configured renderer main frame; packaged navigation is confined to the exact renderer entry file, while development permits only the configured origin.

## Durable Workflow

A recording or import creates a session and an isolated artifact directory. The persistent pipeline advances through:

```text
probe -> playback-proxy -> extract-audio -> transcribe -> [summarize] -> ready
```

Jobs record stage, progress, attempt, and a user-safe error. Local stages are idempotent. Restarted `running` jobs return to `queued`; because compatible provider APIs do not share an idempotency contract, a request interrupted before its result is persisted may be repeated after restart. Cancellation uses `AbortController` and terminates subprocesses.

OBS start and stop are explicit non-idempotent operations. The recording controller writes intent before issuing them, waits for `RecordStateChanged`, reconciles with `GetRecordStatus` after disconnects, and accepts an output only after it is contained in the session directory, stable, and probeable. On restart, active manifests are reattached only when the OBS output directory still matches; finalized artifacts are attached to their session and queued once.

The active-recording manifest is acknowledged only after media has a durable database handoff. A failed or interrupted recovery with no validated artifact retains the manifest for another attempt, and a pending manifest blocks a new recording from overwriting the recovery pointer. OBS profile and scene restoration metadata lives in a separate durable lease: it is written before OBS is mutated, survives recording acknowledgement and crashes, and is removed only after restoration is verified. Renderer IPC is blocked and drained before shutdown, then resumed if the user cancels quitting.

## Provider Extension

Transcription and summary adapters expose capabilities, accept arbitrary model strings, and return canonical documents. A built-in adapter consists of its profile schema, adapter class, registry entry, and conformance fixtures. Runtime JavaScript plugins are intentionally excluded; unsupported local engines can use the CLI adapter, and HTTP engines can use OpenAI-compatible or Ollama endpoints.

The managed Whisper adapter leases a singleton main-process Docker service. The first lease starts the pinned Vulkan container and waits for model readiness; the last lease starts the idle-stop timer. Renderer calls expose only typed lifecycle actions and status, never Docker arguments, model paths, ports, or the Docker socket. Transcript-only jobs skip the optional summary stage, and a local Ollama summary forces an idle Whisper container to stop before inference so both models do not compete for VRAM.

Meeting summaries contain grounded topics, decisions, action items, explicit-assignment metadata, open questions, and risks. Lecture summaries contain a grounded outline, concepts, examples, review questions, and key lessons. Evidence always points to existing transcript utterances.

## Security Invariants

- OBS connections are loopback-only.
- Remote provider HTTP is rejected; only HTTPS or loopback HTTP is accepted.
- Renderer sandbox, context isolation, CSP, sender validation, and navigation blocking remain enabled.
- Paths from OBS, imports, exports, and media URLs are resolved through real filesystem ancestors and confined to the expected root and session, including across symlinks.
- Local CLI executables require an explicit native file-picker grant. Arguments are separate `argv` entries with `shell:false`; secrets enter only the child environment.
- Managed Docker commands use fixed executables and argument arrays with `shell:false`; only an ownership-labelled, image-pinned container can be controlled. Its API is loopback-only, models are mounted read-only, Linux capabilities are dropped, and the Docker socket is never mounted.
- Provider secret references are assigned by the main process under a per-profile namespace.
- Retained provider credentials are revoked when a profile changes provider kind or normalized endpoint origin.
- Provider response bodies are streamed into fixed limits before parsing: 64 MiB for successful output and 32 KiB for error details.
- Logs recursively redact secret-like fields and exclude transcript/summary bodies.
