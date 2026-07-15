"""SessionScribe managed diarization server.

Accepts raw PCM audio over loopback HTTP and returns speaker segments as JSON.
Deliberately minimal: no audio decoding (the app ships PCM it already extracted
with its own FFmpeg), no torchcodec, standard library HTTP server only. The
pyannote community-1 pipeline is loaded once from the read-only /models mount
and kept on the GPU for the lifetime of the process.

Endpoints:
  GET  /health    -> {"status": "ok"} once the pipeline is loaded
  POST /diarize   -> body: raw PCM float32 little-endian mono
                     headers: X-Sample-Rate (required, Hz)
                              X-Num-Speakers (optional, exact speaker count)
                     response: {"segments": [{"startMs", "endMs", "speaker"}]}
"""

from __future__ import annotations

import json
import os
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
from pyannote.audio import Pipeline

MODELS_DIRECTORY = os.environ.get("SESSIONSCRIBE_MODELS", "/models")
PORT = int(os.environ.get("SESSIONSCRIBE_PORT", "8000"))
MAX_BODY_BYTES = 2 * 1024 * 1024 * 1024
MIN_SAMPLE_RATE = 8_000
MAX_SAMPLE_RATE = 192_000

_pipeline: Pipeline | None = None
_pipeline_error: str | None = None
_inference_lock = threading.Lock()


def load_pipeline() -> None:
    global _pipeline, _pipeline_error
    try:
        pipeline = Pipeline.from_pretrained(os.path.join(MODELS_DIRECTORY, "config.yaml"))
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        pipeline.to(device)
        _pipeline = pipeline
        print(f"pipeline ready on {device}", flush=True)
    except Exception as error:  # noqa: BLE001 - surfaced through /health
        _pipeline_error = str(error)
        print(f"pipeline failed to load: {error}", flush=True)


class DiarizationHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        # Never log request contents; timings only.
        print(f"{self.command} {self.path}", flush=True)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self._send(404, {"error": "not found"})
            return
        if _pipeline is not None:
            self._send(200, {"status": "ok"})
        elif _pipeline_error is not None:
            self._send(500, {"status": "error", "detail": _pipeline_error})
        else:
            self._send(503, {"status": "loading"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/diarize":
            self._send(404, {"error": "not found"})
            return
        if _pipeline is None:
            self._send(503, {"error": "pipeline is not ready"})
            return

        try:
            sample_rate = int(self.headers.get("X-Sample-Rate", ""))
        except ValueError:
            self._send(400, {"error": "X-Sample-Rate header is required"})
            return
        if not MIN_SAMPLE_RATE <= sample_rate <= MAX_SAMPLE_RATE:
            self._send(400, {"error": "X-Sample-Rate is out of range"})
            return

        num_speakers: int | None = None
        raw_speakers = self.headers.get("X-Num-Speakers")
        if raw_speakers is not None:
            try:
                num_speakers = int(raw_speakers)
            except ValueError:
                self._send(400, {"error": "X-Num-Speakers must be an integer"})
                return
            if not 1 <= num_speakers <= 32:
                self._send(400, {"error": "X-Num-Speakers is out of range"})
                return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send(400, {"error": "Content-Length is missing or too large"})
            return
        if length % struct.calcsize("f") != 0:
            self._send(400, {"error": "body must be raw PCM float32"})
            return

        body = self.rfile.read(length)
        if len(body) != length:
            self._send(400, {"error": "truncated body"})
            return

        samples = np.frombuffer(body, dtype=np.float32)
        if samples.size == 0 or not np.isfinite(samples).all():
            self._send(400, {"error": "PCM payload contains no finite samples"})
            return
        waveform = torch.from_numpy(samples.copy()).unsqueeze(0)

        options: dict[str, int] = {}
        if num_speakers is not None:
            options["num_speakers"] = num_speakers

        with _inference_lock:
            try:
                result = _pipeline(
                    {"waveform": waveform, "sample_rate": sample_rate}, **options
                )
            except Exception as error:  # noqa: BLE001 - reported as HTTP 500
                self._send(500, {"error": f"diarization failed: {error}"})
                return

        annotation = getattr(result, "exclusive_speaker_diarization", None)
        if annotation is None:
            annotation = getattr(result, "speaker_diarization", result)
        segments = [
            {
                "startMs": round(turn.start * 1000),
                "endMs": round(turn.end * 1000),
                "speaker": label,
            }
            for turn, _, label in annotation.itertracks(yield_label=True)
        ]
        self._send(200, {"segments": segments})

    def _send(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    threading.Thread(target=load_pipeline, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), DiarizationHandler)
    print(f"listening on :{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
