# Managed Local Whisper

SessionScribe can deploy and operate Whisper Large-v3 locally through the official [`whisper.cpp` Vulkan container](https://github.com/ggml-org/whisper.cpp#docker) and its [Vulkan backend](https://github.com/ggml-org/whisper.cpp#vulkan-gpu-support). No transcription API key, ROCm installation, Compose project, or separately managed HTTP service is required. Docker is used as a process supervisor: the model occupies VRAM only while the managed container is running. Managed Whisper produces timestamped transcription but does not perform speaker diarization.

## Host prerequisites

Managed Whisper currently requires all of the following:

- Linux on x86-64 (`uname -m` reports `x86_64`). Windows builds can use the other transcription providers, but do not attempt to deploy this Vulkan container.
- A Vulkan-capable GPU with a working host driver and a render device under `/dev/dri`. The container uses the host's kernel device; Docker does not replace a missing or broken Vulkan driver.
- [Docker Engine](https://docs.docker.com/engine/install/) and the Docker CLI at `/usr/bin/docker` or `/usr/local/bin/docker`. The same unprivileged desktop account that launches SessionScribe must be able to run `docker info` without `sudo`.
- Internet access to GitHub Container Registry and Hugging Face during setup. Normal transcription is offline after the image and models have been installed.
- At least 6 GiB free in the SessionScribe application-data filesystem, plus enough free space in Docker's image store.

Check the host before opening the app:

```bash
uname -m
ls -l /dev/dri
vulkaninfo --summary
docker version
docker info
```

For openSUSE Tumbleweed, the distribution-provided daemon can be installed and started with:

```bash
sudo zypper install docker vulkan-tools
sudo systemctl enable --now docker
```

SessionScribe never invokes `sudo`. Prefer Docker's [rootless mode](https://docs.docker.com/engine/security/rootless/) and confirm that the resulting Docker context is usable from the desktop login. The account must also have permission to open the appropriate `/dev/dri/renderD*` device.

If rootless Docker is not suitable, openSUSE documents the traditional setup in its [Docker guide](https://en.opensuse.org/Docker). The fallback is to add the account to the `docker` group, completely sign out and back in, and then run `docker info` again:

```bash
sudo usermod -aG docker "$USER"
```

Treat that fallback as an administrative decision: Docker warns that [membership in the `docker` group grants root-level privileges](https://docs.docker.com/engine/install/linux-postinstall/#manage-docker-as-a-non-root-user). Do not launch the SessionScribe desktop application itself with `sudo`.

## First deployment and first transcription

1. Install and start Docker, verify Vulkan, and verify `docker info` as the intended desktop user.
2. Start SessionScribe and open the Local Whisper card or Provider Settings.
3. Select **Set up Whisper**. Keep the app open while it checks the host, pulls the container image, downloads both models, verifies them, and creates the service. **Cancel setup** stops the app's setup operation; a later attempt resumes a partial model download when the server supports range requests.
4. Setup creates a `Managed Whisper Large-v3` transcription profile. Leave its language blank for automatic detection, or set a code such as `en` or `de`.
5. Create or import a session and select that transcription profile. Select **No summary — transcript only** when no summary model is wanted; a summary can be generated from the saved transcript later.
6. Finish the recording. Whisper starts during post-processing, not while OBS is recording. The first run after a stop includes the time needed to load Large-v3 into VRAM.
7. After transcription, either click **Stop Whisper** immediately or let the five-minute idle timer release the VRAM automatically.

The setup operation is intentionally reproducible. It installs these exact upstream assets:

| Asset               | Pinned upstream object                                                                                                                                                                                         |       Expected size | SHA-256                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------: | ------------------------------------------------------------------ |
| Vulkan server image | [`main-vulkan-fc674574ca27cac59a15e5b22a09b9d9ad62aafe`](https://github.com/ggml-org/whisper.cpp/pkgs/container/whisper.cpp), digest `sha256:86cfd92553a792b725d8788817fd2abcb487b090c9880955d6a83ea6e7b482c2` |      Docker-managed | Docker verifies the image digest                                   |
| Whisper Large-v3    | [`ggml-large-v3.bin` at revision `c521a4b`](https://huggingface.co/ggerganov/whisper.cpp/blob/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-large-v3.bin)                                                      | 3,095,033,483 bytes | `64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2` |
| Silero VAD 6.2      | [`ggml-silero-v6.2.0.bin` at revision `9ffd54a`](https://huggingface.co/ggml-org/whisper-vad/blob/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin)                                             |       885,098 bytes | `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987` |

Model downloads first go to mode-`0600` `.part` files. During setup, SessionScribe checks the exact byte length and SHA-256, then atomically renames each verified file into place. Setup re-verifies existing files before reusing them, and the first status/start check in a new app process verifies the installed files again.

## Pipeline and VRAM lifecycle

The local data flow is:

```text
OBS recording or imported media
  -> durable processing job
  -> FFprobe validation and optional playback proxy
  -> FFmpeg mono 16 kHz FLAC extraction
  -> acquire managed Whisper lease
  -> start container and wait for readiness when needed
  -> loopback multipart transcription request
  -> canonical timestamped transcript in SQLite
  -> release lease
  -> optional summary, or ready as transcript-only
```

All Docker, filesystem, and network operations occur in Electron's main process. The sandboxed renderer can request only typed setup, status, start, stop, and cancellation actions; it cannot supply a Docker executable, image, argument, port, or model path.

On the first active lease, SessionScribe starts the existing managed container, discovers Docker's dynamically assigned loopback port, and waits up to two minutes for `/health` to return `{"status":"ok"}`. It then uploads only the temporary `audio.flac` to `/v1/audio/transcriptions` on `127.0.0.1`, requesting `verbose_json` for Large-v3 and including the configured language only when one was set. The adapter converts the returned segments into SessionScribe's canonical transcript format before persisting them. The extracted work audio is removed after the processing job succeeds.

Leases prevent the service from being stopped in the middle of a transcription. Manual **Stop Whisper** is unavailable while work is active. When the final lease is released, a five-minute idle countdown begins; a new lease cancels that countdown. Manual **Start Whisper** is useful for preloading the model and follows the same idle policy.

Summary behavior is deliberate:

- With **No summary — transcript only**, the job becomes ready after the transcript is stored. Whisper then follows its normal idle timer.
- Before an Ollama summary, SessionScribe stops an idle Whisper container immediately so the local language model can use the GPU memory.
- A remote summary does not need that handoff, so the normal Whisper idle timer continues.
- Generating a summary later reads the already persisted transcript; it does not transcribe the recording again.

During a normal application shutdown, processing is cancelled or paused first and the managed container is then stopped with a ten-second grace period. On the next launch, SessionScribe recognizes a correctly labelled, correctly pinned container left behind by a crash and resumes managing it. Stopping the container terminates `whisper-server` and releases its VRAM; it does not delete the model files.

## Container boundary

Setup creates exactly one container named `sessionscribe-whisper-v1`, labelled `com.sessionscribe.managed=whisper-v1`. Normal start and stop operations require both that ownership label and the pinned image. Setup may replace an app-labelled container in order to repair or upgrade it, but refuses to take over a same-named container without the ownership label.

The app-created container has the following boundary:

- `restart=no`; it runs only when SessionScribe or the user explicitly starts it.
- Only `/dev/dri` is exposed for Vulkan. The container is not privileged and does not receive the Docker socket.
- The model directory is the only host bind mount and is read-only inside the container.
- The root filesystem is read-only; temporary writable space is limited to a 512 MiB `/tmp` and a 256 MiB `/root/.cache` `tmpfs`.
- All Linux capabilities are dropped and `no-new-privileges` is enabled.
- The container has a 256-process limit and ordinary bridge networking.
- Container port 8080 is published to a dynamically chosen host port on `127.0.0.1` only. It is not reachable from the LAN.
- The fixed server command loads Large-v3 and Silero VAD, uses eight CPU threads, converts input through its bounded temporary directory, and assigns `/v1/audio/transcriptions` as its OpenAI-compatible inference path.

The command inside the container is fixed by the app:

```text
/app/build/bin/whisper-server
  --model /models/ggml-large-v3.bin
  --host 0.0.0.0 --port 8080
  --inference-path /v1/audio/transcriptions
  --language auto --threads 8
  --vad --vad-model /models/ggml-silero-v6.2.0.bin
  --convert --tmp-dir /tmp --no-language-probabilities
```

Docker access itself remains powerful even though this individual container is constrained. SessionScribe invokes a fixed Docker executable with separate argument arrays and never mounts `/var/run/docker.sock` into the container.

## Storage and deployment

Electron's `userData` directory holds the database, secrets, managed-Whisper metadata, model files, and resumable downloads. On a default Linux installation the relevant paths are:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/session-scribe/
  sessionscribe.db
  whisper/
    managed-whisper-v1.json
    models/
      ggml-large-v3.bin
      ggml-silero-v6.2.0.bin
```

The managed files are below that directory; Docker stores the pinned image and container metadata in its own configured data root. Recordings remain separate under `<Videos>/SessionScribe/<session-id>/`. Stopping Whisper keeps both model files and the stopped container, so the next start requires no download. The model occupies disk space but no VRAM while stopped.

For a source/development deployment:

```bash
npm ci
npm run dev
```

Run the development process as the same user and with the same Docker context that passed `docker info`, then perform **Set up Whisper** in the app. The app manages the container; do not create a parallel Compose service on port 8080.

For an installable Linux deployment:

```bash
npm ci
npm run package:linux
```

This produces x64 AppImage and RPM artifacts plus `release/SHA256SUMS`. The package includes FFmpeg/FFprobe, but deliberately does not bundle Docker, the multi-gigabyte Whisper model, the VAD model, or the container image. Each target machine therefore needs the host prerequisites and network access for its first in-app setup. Run the installed application as the Docker-enabled desktop user and use the same first-deployment steps above. Managed Whisper is not deployed as a system service and does not require opening a firewall port.

## Operations and recovery

Prefer the app's status card and **Start Whisper**/**Stop Whisper** controls. The following commands are useful when diagnosing the app-owned container:

```bash
# Show only the managed container and its current state.
docker ps -a --filter 'name=^/sessionscribe-whisper-v1$'

# Verify the pinned image, ownership label, mounts, device, and port binding.
docker inspect sessionscribe-whisper-v1

# Show the dynamically assigned loopback endpoint.
docker port sessionscribe-whisper-v1 8080/tcp

# Read only the most recent server diagnostics.
docker logs --tail 100 sessionscribe-whisper-v1
```

Do not share diagnostics without reviewing them for local paths or other machine details. SessionScribe itself bounds captured Docker output and does not write transcripts, audio, provider payloads, or credentials to its logs.

If SessionScribe crashed and GPU memory remains allocated, the emergency stop is:

```bash
docker stop --time 10 sessionscribe-whisper-v1
```

To recreate only the managed container, first close SessionScribe, inspect the ownership label, and then remove it:

```bash
docker inspect --format '{{ index .Config.Labels "com.sessionscribe.managed" }}' sessionscribe-whisper-v1
docker rm -f sessionscribe-whisper-v1
```

Reopen SessionScribe and select **Set up Whisper**. Verified model files are reused, so removing the container alone does not download Large-v3 again. There is currently no one-click full uninstall; remove the app's managed model directory only while SessionScribe is closed and only if its disk space must also be reclaimed.

## Troubleshooting

| Symptom                                                | Check and resolution                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unsupported on this system**                         | Confirm Linux x86-64, `ls -l /dev/dri`, and `vulkaninfo --summary`. Managed Whisper does not use ROCm and cannot work when the host exposes no Vulkan render device.                                                                                                             |
| **Docker unavailable**                                 | Run `docker version` and `docker info`. Start the system daemon with `sudo systemctl start docker`, or the rootless daemon with `systemctl --user start docker`, as appropriate for the installed configuration. Restart SessionScribe after changing the active Docker context. |
| **Docker permission required**                         | The GUI user cannot reach the daemon socket. Complete the rootless setup, or use the explicitly accepted `docker`-group fallback and fully sign out and back in. Running `sudo docker info` successfully is not sufficient.                                                      |
| Setup stops during an image or model download          | Check connectivity to `ghcr.io` and `huggingface.co` and check free space with `df -h`. Retry setup; verified files are reused and valid partial downloads are resumed. A checksum mismatch is treated as a hard failure, never as an install success.                           |
| A container-name conflict is reported                  | Use `docker inspect sessionscribe-whisper-v1`. Do not let the app take over an unrelated container. Rename or remove the conflicting container yourself only after confirming its owner and purpose.                                                                             |
| Model loading times out or Vulkan initialization fails | Check `docker logs --tail 100 sessionscribe-whisper-v1`, host Vulkan operation, `/dev/dri` permissions, and Docker device passthrough. Updating a host driver may require a reboot; reinstalling ROCm is not a remedy for this Vulkan backend.                                   |
| **Stop Whisper** is disabled                           | A transcription lease is active. Cancel or let the processing job finish, then stop the service. This guard prevents a partial transcript.                                                                                                                                       |
| VRAM is still in use after transcription               | Watch the five-minute countdown or click **Stop Whisper**. After an abnormal termination, use the emergency stop above and confirm the container is no longer running with `docker ps`.                                                                                          |
| Language detection is poor                             | Set the managed profile's language to a specific code such as `en` or `de`, then retry transcription.                                                                                                                                                                            |
| Speakers are not separated                             | This backend provides timestamped segments but no diarization. Set up managed speaker identification ([speaker identification](speaker-identification.md)) for meeting sessions, or use a transcription provider with diarization.                                               |
