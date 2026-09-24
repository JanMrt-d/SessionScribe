# TODO

Open work on SessionScribe. The scope is Linux on the reference system
described in the [README](README.md#reference-system). Ordered by priority;
delete items as they land.

## Open issues

- [ ] **Fix or confirm Wayland window selection.** "Choose another window"
      reportedly did nothing on KDE Wayland. Needs a live session: click the
      button, watch the main-process logs, check whether the KDE portal
      dialog appears (possibly behind windows). The workaround (record in
      OBS directly, then import) works but should not be necessary.
- [ ] **Decide the remote-Docker posture.** Last open Whisper handoff item:
      keep or tighten the loopback-binding inspection and the implicit
      assumption that the Docker daemon is local (DOCKER_HOST pointing at a
      remote daemon would break device passthrough silently).

## Should do

- [ ] **Add screenshots to the README.** The main window, a lecture's
      chapter-structured notes, and the managed runtime cards in Settings.
- [ ] **Expose a speaker-count hint.** The diarization server already
      accepts X-Num-Speakers and `ManagedDiarizationService.diarize` forwards
      it, but `ProcessingController` never passes a value. Plumb an optional
      "number of participants" field from the meeting session dialog through
      to that call to improve clustering.
- [ ] **Slim the diarization image.** The AMD ROCm base is ~50 GB on disk;
      the pytorch.org self-contained wheels are smaller but their MIOpen JIT
      is broken for gfx1201 (RDNA4). Revisit when AMD ships a fixed wheel or
      via TheRock per-GPU-family builds; target under 20 GB.
- [ ] **Broaden e2e coverage.** One Playwright test exists (session create +
      restart restore). Add: provider settings dialog flows and the managed
      runtime cards (mockable), capture workspace preflight.
- [ ] **Self-mirror the diarization weights.** Downloads currently pin a
      commit of the unofficial pyannote-community HF mirror (hash-verified,
      so integrity is guaranteed). For availability, mirror the ~33 MB to a
      GitHub release under this project (CC BY 4.0 permits it).
- [ ] **Unblock the deferred toolchain upgrades.** TypeScript 7 waits for a
      `typescript-eslint` release that accepts it; Vite 8 and
      `@vitejs/plugin-react` 6 wait for an `electron-vite` release that
      accepts Vite 8. Update them together once those land.

## Before publishing release binaries

There are no releases yet; the README tells users to build from source.
These only matter once packages are published.

- [ ] **FFmpeg GPL compliance.** Verify the source-availability mechanism
      for the bundled GPL FFmpeg build satisfies the distribution channel's
      obligations (already flagged in THIRD_PARTY_NOTICES).
- [ ] **Release automation.** Tag → CI builds → GitHub release with
      checksums. Bump the version per release while doing it: artifacts are
      named only `SessionScribe-0.1.0-x86_64.*`, so two builds from different
      commits are indistinguishable except by mtime and SHA-256, which makes
      running a stale binary easy.

## Nice to have

- [ ] Live transcription preview during recording.
- [ ] Vulkan diarization (drop ROCm): revisit when ONNX Runtime's WebGPU EP
      lands in a diarization framework (tracked upstream in sherpa-onnx).
