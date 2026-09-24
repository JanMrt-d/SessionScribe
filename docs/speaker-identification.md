# Managed Speaker Identification (Diarization)

SessionScribe can identify who spoke when in meeting sessions using [pyannote `speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1) (CC BY 4.0) running locally on an AMD GPU through ROCm. With managed Whisper this yields a fully local meeting pipeline: transcription, speaker labels on words and utterances, and meeting summaries whose action items carry per-person assignees. The existing speaker rename and merge tools apply to the detected `SPEAKER_nn` labels.

## Requirements and setup

Diarization requires Linux x64, an AMD GPU with ROCm support exposed through `/dev/kfd` and `/dev/dri`, and the same Docker access as managed Whisper. Set it up in **Settings → Speaker identification**. Installation builds a container image locally from an embedded, digest-pinned Dockerfile (based on AMD's official ROCm PyTorch image — a large one-time download; roughly 50 GB on disk) and downloads the pinned model weights (~33 MB) with SHA-256 verification. No Hugging Face account or token is required.

## Behavior

- Diarization runs automatically as a pipeline stage after transcription for **meeting** sessions whenever the runtime is installed. Lecture sessions and imports processed as lectures skip it.
- Speaker segments are merged into the transcript by maximum word overlap; utterances are split where the speaker changes, so a turn boundary is always an utterance boundary.
- A diarization failure adds a transcript warning and the session still completes; cancellation behaves like every other stage.
- The container binds to loopback only, mounts models read-only, drops all capabilities, and runs as an unprivileged user. Like Whisper, it holds VRAM (~2 GB) only while running and stops after five minutes of inactivity. Both runtimes fit a 16 GB GPU concurrently.
- The container is named `sessionscribe-diarization-v1` and carries the same ownership label scheme as managed Whisper; the `docker` commands in the [Whisper operations section](managed-whisper.md#operations-and-recovery) apply with that name.
