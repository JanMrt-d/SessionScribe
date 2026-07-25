# Shipping TODO

What is left before SessionScribe can be considered shippable. Ordered by
priority; strikethrough or delete items as they land.

## Must do before first real use

- [ ] **Dogfood the full flow on real hardware.** Install both managed
      runtimes through the app UI (Settings → Local Whisper / Speaker
      identification), then run one lecture (record or import → transcript)
      and one meeting (→ transcript with speakers → summary with per-person
      action items) end to end. All container behavior is verified, but the
      in-app install flow has only been exercised by tests.
- [ ] **Fix or confirm Wayland window selection.** "Choose another window"
      reportedly did nothing on KDE Wayland. Needs a live session: click the
      button, watch the main-process logs, check whether the KDE portal
      dialog appears (possibly behind windows). The workaround (record in
      OBS directly, then import) works but should not be necessary.

## Must do before public release

- [ ] **Windows story for managed runtimes.** Both runtimes are Linux-only
      by design; confirm the app degrades cleanly on Windows (status cards
      show "unsupported", cloud/CLI providers still work) and document it.
- [ ] **Code signing.** Windows builds need Authenticode; unsigned builds
      trigger OS warnings (already noted in README).
- [ ] **FFmpeg GPL compliance.** Verify the source-availability mechanism
      for the bundled GPL FFmpeg build satisfies the distribution channel's
      obligations (already flagged in THIRD_PARTY_NOTICES).
- [ ] **Decide the remote-Docker posture.** Last open Whisper handoff item:
      keep or tighten the loopback-binding inspection and the implicit
      assumption that the Docker daemon is local (DOCKER_HOST pointing at a
      remote daemon would break device passthrough silently).

## Should do

- [ ] **Slim the diarization image.** The AMD ROCm base is ~50 GB on disk;
      the pytorch.org self-contained wheels are smaller but their MIOpen JIT
      is broken for gfx1201 (RDNA4). Revisit when AMD ships a fixed wheel or
      via TheRock per-GPU-family builds; target under 20 GB.
- [ ] **Expose a speaker-count hint.** The diarization server already
      accepts X-Num-Speakers; plumb an optional "number of participants"
      field into the meeting session dialog to improve clustering.
- [ ] **Broaden e2e coverage.** One Playwright test exists (session create +
      restart restore). Add: provider settings dialog flows and the managed
      runtime cards (mockable), capture workspace preflight.
- [ ] **Self-mirror the diarization weights.** Downloads currently pin a
      commit of the unofficial pyannote-community HF mirror (hash-verified,
      so integrity is guaranteed). For availability, mirror the ~33 MB to a
      GitHub release under this project (CC BY 4.0 permits it).

## Nice to have

- [ ] Release automation: tag → CI builds → GitHub release with checksums.
      Bump the version per release while doing it: artifacts are named only
      `SessionScribe-0.1.0-x86_64.*`, so two builds from different commits are
      indistinguishable except by mtime and SHA-256, which makes dogfooding a
      stale binary easy.
- [ ] Live transcription preview during recording.
- [ ] Vulkan diarization (drop ROCm): revisit when ONNX Runtime's WebGPU EP
      lands in a diarization framework (tracked upstream in sherpa-onnx).
