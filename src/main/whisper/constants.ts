export const MANAGED_WHISPER_CONTAINER_NAME = 'sessionscribe-whisper-v1'
export const MANAGED_WHISPER_LABEL_KEY = 'com.sessionscribe.managed'
export const MANAGED_WHISPER_LABEL_VALUE = 'whisper-v1'

export const MANAGED_WHISPER_IMAGE =
  'ghcr.io/ggml-org/whisper.cpp:main-vulkan-fc674574ca27cac59a15e5b22a09b9d9ad62aafe@sha256:86cfd92553a792b725d8788817fd2abcb487b090c9880955d6a83ea6e7b482c2'

export interface WhisperDownloadAsset {
  readonly fileName: string
  readonly url: string
  readonly size: number
  readonly sha256: string
}

export const WHISPER_LARGE_V3_ASSET: WhisperDownloadAsset = {
  fileName: 'ggml-large-v3.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-large-v3.bin?download=true',
  size: 3_095_033_483,
  sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2'
}

export const WHISPER_SILERO_VAD_ASSET: WhisperDownloadAsset = {
  fileName: 'ggml-silero-v6.2.0.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin?download=true',
  size: 885_098,
  sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987'
}

export const MANAGED_WHISPER_IDLE_TIMEOUT_MS = 5 * 60 * 1_000
export const MANAGED_WHISPER_READINESS_TIMEOUT_MS = 2 * 60 * 1_000
export const MANAGED_WHISPER_MINIMUM_FREE_BYTES = 6 * 1_024 * 1_024 * 1_024
