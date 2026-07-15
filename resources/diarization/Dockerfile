# SessionScribe managed diarization runtime.
#
# Built locally by the app at install time (there is no upstream image to pin,
# unlike managed Whisper). Based on AMD's official ROCm PyTorch image, pinned
# by digest: its MIOpen kernel toolchain is validated on RDNA4 (gfx1201),
# whereas the self-contained pytorch.org ROCm wheels currently fail to JIT
# BatchNorm kernels for that architecture. The image is large (~50 GB on
# disk); a slimmer base is a tracked follow-up.
#
# Model weights are NOT baked in — the app downloads and SHA-256-verifies
# them separately and mounts them read-only at /models.
#
# rocm/pytorch:rocm7.2.4_ubuntu24.04_py3.12_pytorch_release_2.10.0
FROM rocm/pytorch@sha256:4449f856653602317e4101a76fce599c7fcd58ccec2e539951fce5f73083179e

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# torchcodec arrives CUDA-flavoured and non-functional; that is acceptable —
# the server feeds pyannote in-memory waveforms and never decodes files.
RUN pip install pyannote.audio==4.0.7

# The unprivileged runtime user needs a real passwd entry because torch
# resolves it via getpwuid at import time; its home lives on the writable
# tmpfs so MIOpen can write (and re-load) its kernel cache under /tmp.
RUN useradd --uid 61000 --user-group --home-dir /tmp --shell /usr/sbin/nologin sessionscribe

COPY server.py /app/server.py

# gfx1201 workaround: rocBLAS falls off a performance cliff through hipBLASLt
# on this architecture (ROCm/ROCm#6203). Harmless elsewhere.
ENV ROCBLAS_USE_HIPBLASLT=0 \
    HF_HUB_OFFLINE=1 \
    HOME=/tmp \
    SESSIONSCRIBE_MODELS=/models \
    SESSIONSCRIBE_PORT=8000

USER sessionscribe
EXPOSE 8000
ENTRYPOINT ["python3", "/app/server.py"]
