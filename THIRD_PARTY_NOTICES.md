# Third-Party Notices

SessionScribe is distributed with its npm dependency notices as recorded in `package-lock.json`.

Release packages may include separate FFmpeg and FFprobe executables. Those executables remain independent programs and are covered by the license of the exact build placed in `resources/bin`. `npm run prepare:ffmpeg` places the matching license texts, version/build configuration, package provenance, and corresponding FFmpeg source archive URLs beside those binaries. `npm run checksums` writes installer hashes to `release/SHA256SUMS`.

The generated installers in this repository are unsigned development artifacts. Before public redistribution, verify that the source-availability mechanism used for the bundled GPL FFmpeg build satisfies the distribution channel's obligations and add platform code signing.

SessionScribe can optionally download and run the official `ggml-org/whisper.cpp` Vulkan container and converted Whisper/Silero VAD model files. These assets are not bundled in SessionScribe installers and retain their respective upstream licenses and notices.
