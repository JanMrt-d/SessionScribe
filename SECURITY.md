# Security Policy

## Supported Versions

SessionScribe is pre-1.0. Only the latest release and the `main` branch receive
security fixes.

## Reporting a Vulnerability

Please do not open a public issue for a security problem.

Report it through GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**), or by email to <janmertes@outlook.com>.
Include the affected version, the platform, and the smallest set of steps that
reproduces the issue. You will get an acknowledgement within seven days.

## Scope

SessionScribe is a local-first desktop application with no backend, no account
system, and no telemetry. The security-relevant surfaces are:

- **The renderer boundary.** The renderer is sandboxed, has no Node.js access,
  and reaches the main process only through the typed `SessionScribeApi`
  preload contract. Anything that leaks credentials, unrestricted filesystem
  paths, or raw provider payloads into the renderer is in scope.
- **Path handling.** Paths from OBS, imports, exports, and media URLs are
  resolved through real filesystem ancestors and confined to the expected root
  and session, including across symlinks. Escapes from that confinement are in
  scope.
- **Managed Docker runtimes.** The managed Whisper and diarization containers
  are image-pinned, loopback-only, run with dropped capabilities and read-only
  model mounts, and never mount the Docker socket. Anything that widens that
  boundary is in scope.
- **Secret handling.** Provider credentials live in the OS keychain under a
  per-profile namespace, enter only a child process environment, and are
  redacted from logs. Any path that writes a credential to disk, a log, or the
  database is in scope.
- **Network policy.** Remote provider HTTP is rejected; only HTTPS or loopback
  HTTP is accepted. OBS connections are loopback-only.

Out of scope: vulnerabilities in OBS Studio, Docker, FFmpeg, or third-party
provider services themselves — report those upstream. Findings that require an
attacker to already have local code execution as the desktop user are also out
of scope, since that already grants access to everything the application can
reach.

## Third-Party Components

Model weights and container images are downloaded at the user's explicit
request, pinned by digest or SHA-256, and verified before use. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
