# SessionScribe

SessionScribe is a local-first Windows and Linux desktop application that records a selected window through OBS Studio, transcribes the audio with a provider chosen by the user, and creates grounded meeting or lecture notes.

## Capabilities

- Controls a user-installed OBS Studio over its local WebSocket API.
- Supports Windows window capture, Linux X11 capture, and the user-driven Wayland PipeWire portal.
- Imports existing audio and video when recording is not needed.
- Uses separate, reusable profiles for transcription and summarization.
- Includes ElevenLabs Scribe, OpenAI-compatible transcription, a local transcription CLI, OpenAI-compatible summaries, and Ollama summaries.
- Keeps model IDs and compatible endpoint URLs editable instead of enforcing a provider catalog.
- Preserves transcript and summary revisions, including speaker rename/merge and manual edits.
- Exports Markdown, canonical JSON, SRT, and VTT.

## Prerequisites

- Node.js 24 and npm for development.
- OBS Studio 32.x with **Tools > WebSocket Server Settings** enabled for recording.
- FFmpeg and FFprobe on `PATH` for development. Release packages include platform binaries.
- An API key entered in the application for cloud providers, or a user-managed local CLI/Ollama service.

On Linux Wayland, OBS opens the system capture portal. SessionScribe cannot and does not bypass that consent dialog. Linux system audio uses the selected output device rather than per-application isolation.

OBS WebSocket is disabled in some installations. Enable the server, choose a password, and enter the same password in SessionScribe. On Wayland, use **Choose another window** whenever the portal grant should be replaced.

## Development

```bash
npm ci
npm run dev
```

Quality gates:

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
npm run test:e2e
```

Package unsigned x64 builds with `npm run package:linux` or `npm run package:win`, then create installer hashes with `npm run checksums`. The Linux package can be exercised with `npm run test:e2e:packaged:linux`. Public Windows distribution should add Authenticode signing; unsigned development builds will trigger operating-system warnings. CI verifies both operating systems and produces Linux and Windows artifacts on native runners.

## Provider Freedom

Provider profiles store only non-secret settings in SQLite. Credentials use Electron `safeStorage`; when Linux exposes only the insecure `basic_text` backend, credentials remain in memory for the current run.

Model fields are free text. OpenAI-compatible profiles support custom HTTPS base URLs, both Responses and Chat Completions styles, structured-output modes, guarded extra request fields, and protected custom headers. HTTP is accepted only for loopback services such as Ollama. The local CLI adapter requires the executable to be authorized through the operating-system file picker, launches it with a separate argument array, and never invokes a shell. CLI arguments use `{input}`, with optional `{output}`, `{model}`, and `{language}` placeholders.

Stored credentials remain attached only to the same provider kind and normalized endpoint origin. Changing either clears retained credentials unless replacements are entered in the same save. Provider responses are consumed with bounded streaming before parsing so a custom endpoint cannot return an unbounded body to the desktop process.

The initial profiles use ElevenLabs [`scribe_v2`](https://elevenlabs.io/docs/overview/models) for long-form diarized transcription and OpenAI [`gpt-5.6-terra`](https://developers.openai.com/api/docs/models/gpt-5.6-terra) for a strong quality/cost summary default. New-profile suggestions include [`gpt-4o-transcribe-diarize`](https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize), `scribe_v2`, `gpt-5.6-terra`, and local Ollama [`qwen3.5:9b`](https://ollama.com/library/qwen3.5). These are editable presets, not a provider lock-in. [`gpt-5.6-sol`](https://developers.openai.com/api/docs/models/gpt-5.6-sol) is the current higher-cost quality preset for summaries. OpenAI transcription uploads are limited by the configured profile and are not automatically chunked; ElevenLabs or a local CLI is the practical default for recordings above that limit.

The shipped profile templates were checked against provider documentation on 2026-07-13. Change them in Settings whenever a more appropriate model is available. Ollama profiles target a local server and structured-output-capable local model; cloud tags are not supported by this adapter.

## Data Layout

The database and encrypted secrets live in Electron's platform `userData` directory. Recordings and review media live under:

```text
<Videos>/SessionScribe/<session-id>/
```

Recordings, transcript revisions, and summary revisions remain until the user deletes the session. Temporary extracted audio, provider chunks, and raw provider responses are removed after successful processing.

## Privacy

There is no SessionScribe account, backend, telemetry, or cloud storage. Selecting a cloud profile sends the required media or transcript to that profile's configured endpoint. The active provider is always visible before processing.

Provider calls are cancellable and persisted stages resume after restart. A remote request interrupted before its result is durably saved may be repeated because compatible APIs do not share an idempotency contract; that can incur another provider charge.
