import type { WhisperDownloadAsset } from '../whisper/constants'

export const MANAGED_DIARIZATION_CONTAINER_NAME = 'sessionscribe-diarization-v1'
export const MANAGED_DIARIZATION_IMAGE_TAG = 'sessionscribe-diarization:v1'
export const MANAGED_DIARIZATION_LABEL_KEY = 'com.sessionscribe.managed'
export const MANAGED_DIARIZATION_LABEL_VALUE = 'diarization-v1'

/**
 * pyannote speaker-diarization-community-1 (CC-BY-4.0, © pyannoteAI).
 * Pinned to a specific commit of the community mirror; every file is verified
 * by SHA-256 before use, so the mirror does not need to be trusted. The LFS
 * hashes below match the values declared by the Hugging Face API for the
 * pinned commit and were independently verified against downloaded bytes.
 */
const COMMUNITY_1_BASE =
  'https://huggingface.co/pyannote-community/speaker-diarization-community-1/resolve/8a527374977391da736e0daaef26855d949d9685'

export interface DiarizationDownloadAsset extends WhisperDownloadAsset {
  /** Path relative to the models directory, using forward slashes. */
  readonly relativePath: string
}

export const DIARIZATION_MODEL_ASSETS: readonly DiarizationDownloadAsset[] = [
  {
    fileName: 'config.yaml',
    relativePath: 'config.yaml',
    url: `${COMMUNITY_1_BASE}/config.yaml?download=true`,
    size: 444,
    sha256: '5ce2bfa9a938dc132cec1172592d65173cbb8f444ea1e4133f10f9391de155be'
  },
  {
    fileName: 'pytorch_model.bin',
    relativePath: 'segmentation/pytorch_model.bin',
    url: `${COMMUNITY_1_BASE}/segmentation/pytorch_model.bin?download=true`,
    size: 5_906_507,
    sha256: '7ad24338d844fb95985486eb1a464e32d229f6d7a03c9abe60f978bacf3f816e'
  },
  {
    fileName: 'pytorch_model.bin',
    relativePath: 'embedding/pytorch_model.bin',
    url: `${COMMUNITY_1_BASE}/embedding/pytorch_model.bin?download=true`,
    size: 26_646_242,
    sha256: '6f10ff60898a1d185fa22e1d11e0bfa8a92efec811f11bca48cb8cafebefd929'
  },
  {
    fileName: 'plda.npz',
    relativePath: 'plda/plda.npz',
    url: `${COMMUNITY_1_BASE}/plda/plda.npz?download=true`,
    size: 133_852,
    sha256: '9b77bcd840692710dd3496f62ecfeed8d8e5f002fd991b785079b244eab7d255'
  },
  {
    fileName: 'xvec_transform.npz',
    relativePath: 'plda/xvec_transform.npz',
    url: `${COMMUNITY_1_BASE}/plda/xvec_transform.npz?download=true`,
    size: 134_376,
    sha256: '325f1ce8e48f7e55e9c8aa47e05d2766b7c48c4b25b8de8dd751e7a4cc5fbe8f'
  }
]

export const MANAGED_DIARIZATION_IDLE_TIMEOUT_MS = 5 * 60 * 1_000
export const MANAGED_DIARIZATION_READINESS_TIMEOUT_MS = 5 * 60 * 1_000
/** Image build downloads the ~6 GB ROCm torch wheel; allow a slow connection. */
export const MANAGED_DIARIZATION_BUILD_TIMEOUT_MS = 60 * 60 * 1_000
export const MANAGED_DIARIZATION_MINIMUM_FREE_BYTES = 25 * 1_024 * 1_024 * 1_024
