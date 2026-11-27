#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Nibgrid Local Loopback Bridge (Zero-Dependency, uv-compatible)

Connects the static GitHub Pages Nibgrid PWA (or local dev server) to local
Antigravity / Gemini / offline mock pipelines over 127.0.0.1 with strict
Origin allowlisting, Chrome Private Network Access (PNA) headers, and
constant-time Bearer authentication.

Usage:
  uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py --mock
  uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py --port 4188
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import io
import json
import math
import os
import re
import secrets
import signal
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave
import zlib
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

BRIDGE_VERSION = "0.2.0"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4188
MAX_BODY_BYTES = 16 * 1024 * 1024  # 16 MiB
LEGACY_MAX_BODY_BYTES = 25 * 1024 * 1024  # 25 MiB for M10 compatibility

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

DEFAULT_ALLOWED_ORIGINS = frozenset(
    {
        "https://franekjemiolo.github.io",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    }
)

_SECRET_PATTERNS = (
    re.compile(r"AIza[0-9A-Za-z_-]{10,}"),
    re.compile(r"sk-[0-9A-Za-z_-]{10,}"),
    re.compile(r"nbg_[0-9A-Za-z_-]{8,}"),
    re.compile(r"(Bearer\s+)[^\s\"']+"),
)


def redact_secrets(text: str, extra_secrets: tuple[str, ...] = ()) -> str:
    """Redact API keys, Bearer tokens, and explicit secrets from text."""
    result = text
    for secret in extra_secrets:
        if secret:
            result = result.replace(secret, "[REDACTED]")
    for idx, pattern in enumerate(_SECRET_PATTERNS):
        if idx == 3:
            result = pattern.sub(r"\1[REDACTED]", result)
        else:
            result = pattern.sub("[REDACTED]", result)
    return result


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    body = chunk_type + data
    crc = zlib.crc32(body) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + body + struct.pack(">I", crc)


def make_mock_png_b64(width: int = 32, height: int = 32, seed: str = "nibgrid") -> str:
    """Encode a deterministic RGBA PNG sprite purely with Python stdlib."""
    w = max(1, min(int(width), 512))
    h = max(1, min(int(height), 512))
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    r1, g1, b1 = digest[0], digest[1], digest[2]
    r2, g2, b2 = digest[3], digest[4], digest[5]
    border = (24, 24, 36, 255)
    primary = (r1, g1, b1, 255)
    secondary = (r2, g2, b2, 255)

    rows = bytearray()
    for y in range(h):
        rows.append(0)  # Filter type 0 (None)
        for x in range(w):
            if x == 0 or y == 0 or x == w - 1 or y == h - 1:
                px = border
            elif ((x // 4) + (y // 4)) % 2 == 0:
                px = primary
            else:
                px = secondary
            rows.extend(px)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(bytes(rows), level=6)
    png_bytes = (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", idat)
        + _png_chunk(b"IEND", b"")
    )
    return base64.b64encode(png_bytes).decode("ascii")


def make_mock_wav_b64(
    duration_s: float = 0.25,
    freq_hz: float = 440.0,
    sample_rate: int = 22050,
) -> str:
    """Encode a deterministic 16-bit mono PCM WAV tone purely with stdlib."""
    clamped_duration = max(0.05, min(float(duration_s), 5.0))
    clamped_freq = max(60.0, min(float(freq_hz), 4000.0))
    n_frames = max(1, int(clamped_duration * sample_rate))

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_frames):
            t = i / sample_rate
            env = min(1.0, i / max(1, int(0.01 * sample_rate))) * max(
                0.0, 1.0 - (i / n_frames) * 0.5
            )
            sample = int(12000 * env * math.sin(2.0 * math.pi * clamped_freq * t))
            frames.extend(struct.pack("<h", max(-32768, min(32767, sample))))
        wf.writeframes(bytes(frames))
    return base64.b64encode(buf.getvalue()).decode("ascii")


@dataclass(frozen=True, kw_only=True)
class BridgeConfig:
    port: int = DEFAULT_PORT
    token: str = ""
    allowed_origins: frozenset[str] = DEFAULT_ALLOWED_ORIGINS
    mock: bool = False
    gemini_api_key: str = ""
    require_health_auth: bool = False
    max_body_bytes: int = MAX_BODY_BYTES
    overflow_status: HTTPStatus = HTTPStatus.BAD_REQUEST
    overflow_message: str = "Request body exceeds maximum allowed size (16 MB)."
    allow_any_loopback_origin: bool = False


def is_origin_allowed(origin: str, config: BridgeConfig) -> bool:
    """Check whether an HTTP Origin header is explicitly allowlisted."""
    if not origin:
        return True
    if origin in config.allowed_origins:
        return True
    if config.allow_any_loopback_origin:
        parsed = urlparse(origin)
        if parsed.scheme in {"http", "https"} and parsed.hostname in {
            "localhost",
            "127.0.0.1",
            "::1",
        }:
            return True
    return False


def _forward_gemini_json(
    model: str,
    payload: dict[str, Any],
    api_key: str,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Forward a JSON request to the Gemini Developer API REST endpoint."""
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not configured for live bridge mode.")
    safe_model = re.sub(r"[^a-zA-Z0-9._-]", "", model) or "gemini-2.5-flash"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{safe_model}:generateContent"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Gemini upstream HTTP {exc.code}: {redact_secrets(err_body, (api_key,))}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Gemini upstream connection error: {redact_secrets(str(exc.reason), (api_key,))}"
        ) from exc


def make_handler(config: BridgeConfig) -> type[BaseHTTPRequestHandler]:
    """Build a request handler class bound to the provided immutable BridgeConfig."""
    sessions: dict[str, str] = {}
    sessions_lock = threading.Lock()

    class BridgeHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = f"NibgridBridge/{BRIDGE_VERSION}"

        def log_message(self, format: str, *args: Any) -> None:
            msg = format % args if args else format
            safe_msg = redact_secrets(
                msg, (config.token, config.gemini_api_key)
            )
            sys.stderr.write(f"[nibgrid-bridge] {safe_msg}\n")

        def _get_origin(self) -> str:
            return self.headers.get("Origin", "").strip()

        def _send_cors_and_security_headers(self, origin: str) -> None:
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Vary", "Origin")
            if origin and is_origin_allowed(origin, config):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header(
                    "Access-Control-Allow-Methods", "GET, POST, OPTIONS"
                )
                self.send_header(
                    "Access-Control-Allow-Headers",
                    "Content-Type, Authorization, X-Requested-With",
                )
                self.send_header("Access-Control-Allow-Private-Network", "true")

        def _send_json(
            self,
            status: HTTPStatus | int,
            payload: dict[str, Any],
            origin: str = "",
        ) -> None:
            raw = json.dumps(payload).encode("utf-8")
            code = int(status)
            if code >= 400:
                self.close_connection = True
            self.send_response(code)
            self._send_cors_and_security_headers(origin)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            if code >= 400:
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(raw)

        def _check_origin(self) -> tuple[bool, str]:
            origin = self._get_origin()
            if origin and not is_origin_allowed(origin, config):
                self._send_json(
                    HTTPStatus.FORBIDDEN,
                    {"error": f"Origin '{origin}' is not allowlisted."},
                )
                return False, origin
            return True, origin

        def _is_authorized(self) -> bool:
            auth_header = self.headers.get("Authorization", "")
            if not auth_header.startswith("Bearer "):
                return False
            presented = auth_header[len("Bearer ") :].strip()
            if not config.token or not presented:
                return False
            return hmac.compare_digest(
                presented.encode("utf-8"), config.token.encode("utf-8")
            )

        def _read_json_body(self, origin: str) -> dict[str, Any] | None:
            raw_len = self.headers.get("Content-Length")
            if raw_len is None:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "Missing Content-Length header."},
                    origin=origin,
                )
                return None
            try:
                content_length = int(raw_len)
            except ValueError:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "Invalid Content-Length header."},
                    origin=origin,
                )
                return None
            if content_length < 0:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "Negative Content-Length header."},
                    origin=origin,
                )
                return None
            if content_length > config.max_body_bytes:
                self._send_json(
                    config.overflow_status,
                    {"error": config.overflow_message},
                    origin=origin,
                )
                return None
            raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
            try:
                parsed = json.loads(raw_body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "Malformed JSON request body."},
                    origin=origin,
                )
                return None
            if not isinstance(parsed, dict):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "JSON payload must be an object."},
                    origin=origin,
                )
                return None
            return parsed

        def do_OPTIONS(self) -> None:
            ok, origin = self._check_origin()
            if not ok:
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self._send_cors_and_security_headers(origin)
            if not origin:
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header(
                    "Access-Control-Allow-Methods", "GET, POST, OPTIONS"
                )
                self.send_header(
                    "Access-Control-Allow-Headers",
                    "Content-Type, Authorization, X-Requested-With",
                )
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:
            ok, origin = self._check_origin()
            if not ok:
                return
            path = urlparse(self.path).path
            if path == "/v1/health":
                if config.require_health_auth and not self._is_authorized():
                    self._send_json(
                        HTTPStatus.UNAUTHORIZED,
                        {"error": "Unauthorized: missing or invalid Bearer token."},
                        origin=origin,
                    )
                    return
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "status": "ok",
                        "ok": True,
                        "bridge": "nibgrid-loopback",
                        "version": BRIDGE_VERSION,
                        "mock": config.mock,
                        "authRequired": True,
                        "models": [
                            "gemini-2.5-flash-image",
                            "gemini-3-pro-image",
                        ],
                        "supportsStatefulInteractions": True,
                    },
                    origin=origin,
                )
                return

            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"error": f"Unknown endpoint: {path}"},
                origin=origin,
            )

        def do_POST(self) -> None:
            ok, origin = self._check_origin()
            if not ok:
                return
            if not self._is_authorized():
                self._send_json(
                    HTTPStatus.UNAUTHORIZED,
                    {"error": "Unauthorized: missing or invalid Bearer token."},
                    origin=origin,
                )
                return

            payload = self._read_json_body(origin)
            if payload is None:
                return

            path = urlparse(self.path).path
            if path in {"/v1/image/generate", "/v1/image/inpaint"}:
                self._handle_image_v2(payload, origin)
                return
            if path == "/v1/audio/generate":
                self._handle_audio_generate(payload, origin)
                return
            if path == "/v1/llm/json":
                self._handle_llm_json(payload, origin)
                return
            if path == "/v1/vision/qa":
                self._handle_vision_qa(payload, origin)
                return
            if path in {"/v1/generate", "/v1/inpaint"}:
                self._handle_legacy_generate(payload, origin)
                return
            if path == "/v1/critique":
                self._handle_vision_qa(payload, origin)
                return
            if path.startswith("/v1/cancel/"):
                request_id = path[len("/v1/cancel/") :]
                self._send_json(
                    HTTPStatus.OK,
                    {"cancelled": True, "requestId": request_id},
                    origin=origin,
                )
                return

            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"error": f"Unknown endpoint: {path}"},
                origin=origin,
            )

        def _handle_image_v2(self, payload: dict[str, Any], origin: str) -> None:
            width = int(payload.get("width", 32) or 32)
            height = int(payload.get("height", 32) or 32)
            seed = str(payload.get("prompt", payload.get("seed", "nibgrid")))
            if config.mock:
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "mock": True,
                        "mimeType": "image/png",
                        "imageBase64": make_mock_png_b64(width, height, seed),
                        "width": width,
                        "height": height,
                    },
                    origin=origin,
                )
                return

            model = str(payload.get("model", "gemini-2.5-flash-image"))
            gemini_payload = payload.get("geminiPayload") or {
                "contents": [{"parts": [{"text": seed}]}]
            }
            try:
                result = _forward_gemini_json(
                    model, gemini_payload, config.gemini_api_key
                )
                self._send_json(HTTPStatus.OK, result, origin=origin)
            except RuntimeError as exc:
                self._send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": redact_secrets(str(exc), (config.gemini_api_key,))},
                    origin=origin,
                )

        def _handle_audio_generate(
            self, payload: dict[str, Any], origin: str
        ) -> None:
            if config.mock:
                duration_s = float(payload.get("durationSeconds", 0.25) or 0.25)
                freq_hz = float(payload.get("frequencyHz", 440.0) or 440.0)
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "mock": True,
                        "mimeType": "audio/wav",
                        "audioBase64": make_mock_wav_b64(duration_s, freq_hz),
                    },
                    origin=origin,
                )
                return

            self._send_json(
                HTTPStatus.NOT_IMPLEMENTED,
                {
                    "error": "Live audio generation requires --mock or local audio synthesis."
                },
                origin=origin,
            )

        def _handle_llm_json(self, payload: dict[str, Any], origin: str) -> None:
            prompt = str(payload.get("prompt", "nibgrid"))
            if config.mock:
                structured = {
                    "ok": True,
                    "summary": "Deterministic mock JSON response",
                    "prompt": prompt,
                }
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "mock": True,
                        "text": json.dumps(structured),
                        "json": structured,
                    },
                    origin=origin,
                )
                return

            model = str(payload.get("model", "gemini-2.5-flash"))
            gemini_payload = payload.get("geminiPayload") or {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json"},
            }
            try:
                result = _forward_gemini_json(
                    model, gemini_payload, config.gemini_api_key
                )
                self._send_json(HTTPStatus.OK, result, origin=origin)
            except RuntimeError as exc:
                self._send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": redact_secrets(str(exc), (config.gemini_api_key,))},
                    origin=origin,
                )

        def _handle_vision_qa(self, payload: dict[str, Any], origin: str) -> None:
            if config.mock:
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "mock": True,
                        "overallScore": 92,
                        "globalNotes": "Mock deterministic pixel QA pass.",
                        "findings": [],
                    },
                    origin=origin,
                )
                return

            model = str(payload.get("model", "gemini-2.5-flash"))
            gemini_payload = payload.get("geminiPayload") or {
                "contents": [
                    {
                        "parts": [
                            {
                                "text": str(
                                    payload.get("prompt", "Inspect pixel asset quality.")
                                )
                            }
                        ]
                    }
                ],
                "generationConfig": {"responseMimeType": "application/json"},
            }
            try:
                result = _forward_gemini_json(
                    model, gemini_payload, config.gemini_api_key
                )
                self._send_json(HTTPStatus.OK, result, origin=origin)
            except RuntimeError as exc:
                self._send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": redact_secrets(str(exc), (config.gemini_api_key,))},
                    origin=origin,
                )

        def _handle_legacy_generate(
            self, payload: dict[str, Any], origin: str
        ) -> None:
            started = time.monotonic()
            session_key = str(payload.get("sessionKey", "") or "")
            prev_id = payload.get("previousInteractionId")
            with sessions_lock:
                if not prev_id and session_key and session_key in sessions:
                    prev_id = sessions[session_key]
                used_stateful_chain = bool(prev_id)
                interaction_id = f"int_{uuid.uuid4().hex[:12]}"
                if session_key:
                    sessions[session_key] = interaction_id

            variants_count = max(1, min(int(payload.get("variants", 1) or 1), 4))
            seed = str(payload.get("prompt", "nibgrid"))
            variants = [
                {
                    "id": f"var_{uuid.uuid4().hex[:8]}",
                    "interactionId": interaction_id,
                    "imageBase64": make_mock_png_b64(32, 32, f"{seed}:{i}"),
                    "mimeType": "image/png",
                    "seed": i + 1,
                    "notes": "mock variant" if config.mock else "live variant",
                }
                for i in range(variants_count)
            ]
            elapsed_ms = max(1, int((time.monotonic() - started) * 1000))
            self._send_json(
                HTTPStatus.OK,
                {
                    "requestId": f"req_{uuid.uuid4().hex[:12]}",
                    "interactionId": interaction_id,
                    "usedStatefulChain": used_stateful_chain,
                    "latencyMs": elapsed_ms,
                    "variants": variants,
                },
                origin=origin,
            )

    return BridgeHandler


def create_bridge_server(
    host: str,
    port: int,
    mock_mode: bool,
    token: str | None = None,
) -> ThreadingHTTPServer:
    """Create a ThreadingHTTPServer bound strictly to a loopback host (M10 compatible)."""
    if host not in LOOPBACK_HOSTS:
        raise ValueError(
            f"Refusing to bind bridge to non-loopback host '{host}'. Use 127.0.0.1."
        )
    resolved_token = token or f"nbg_{secrets.token_urlsafe(24)}"
    config = BridgeConfig(
        port=port,
        token=resolved_token,
        allowed_origins=DEFAULT_ALLOWED_ORIGINS,
        mock=mock_mode,
        gemini_api_key=os.environ.get("GEMINI_API_KEY", ""),
        require_health_auth=True,
        max_body_bytes=LEGACY_MAX_BODY_BYTES,
        overflow_status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
        overflow_message="Request body exceeds 25 MB limit.",
        allow_any_loopback_origin=True,
    )
    httpd = ThreadingHTTPServer((host, port), make_handler(config))
    httpd.session_token = resolved_token  # type: ignore[attr-defined]
    httpd.mock_mode = mock_mode  # type: ignore[attr-defined]
    return httpd


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Nibgrid zero-dependency local loopback bridge server."
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Loopback TCP port to listen on (default: {DEFAULT_PORT}).",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Run in deterministic offline mock mode returning stdlib PNG/WAV payloads.",
    )
    parser.add_argument(
        "--token",
        default="",
        help="Optional explicit Bearer token (defaults to ephemeral nbg_ token).",
    )
    parser.add_argument(
        "--allow-origin",
        action="append",
        default=[],
        help="Additional exact Origin URL to allowlist (repeatable).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    token = args.token or f"nbg_{secrets.token_urlsafe(24)}"
    allowed_origins = DEFAULT_ALLOWED_ORIGINS | frozenset(args.allow_origin)
    config = BridgeConfig(
        port=args.port,
        token=token,
        allowed_origins=allowed_origins,
        mock=bool(args.mock),
        gemini_api_key=os.environ.get("GEMINI_API_KEY", ""),
        require_health_auth=False,
        max_body_bytes=MAX_BODY_BYTES,
        overflow_status=HTTPStatus.BAD_REQUEST,
        overflow_message="Request body exceeds maximum allowed size (16 MB).",
        allow_any_loopback_origin=False,
    )
    httpd = ThreadingHTTPServer((DEFAULT_HOST, args.port), make_handler(config))
    actual_port = httpd.server_address[1]

    def _shutdown(_signum: int, _frame: Any) -> None:
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGINT, _shutdown)
        signal.signal(signal.SIGTERM, _shutdown)

    print(
        f"Nibgrid loopback bridge listening on http://{DEFAULT_HOST}:{actual_port}",
        flush=True,
    )
    print(f"Mode: {'mock' if config.mock else 'live'}", flush=True)
    print(f"Bearer Token: {token}", flush=True)
    print("Press Ctrl+C to stop.", flush=True)

    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
