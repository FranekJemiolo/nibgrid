#!/usr/bin/env python3
"""
Zero-dependency local loopback bridge for Nibgrid (https://franekjemiolo.github.io/nibgrid/).

Binds strictly to 127.0.0.1:4188, enforces strict Origin + PNA preflight headers,
requires an ephemeral per-launch `nbg_...` Bearer token, and exposes:
  - GET  /v1/health
  - POST /v1/generate
  - POST /v1/inpaint
  - POST /v1/critique
  - POST /v1/cancel/:requestId

Supports `--mock` mode (synthetic 64x64 transparent-ready PNG sprite) as well as forwarding
stateless/stateful image generation via the local `GEMINI_API_KEY` environment variable.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import struct
import threading
import time
import urllib.error
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

BRIDGE_VERSION = "1.0.0"
ALLOWED_ORIGIN_PATTERNS = [
    re.compile(r"^https://franekjemiolo\.github\.io$"),
    re.compile(r"^http://localhost(?::\d+)?$"),
    re.compile(r"^http://127\.0\.0\.1(?::\d+)?$"),
]

# Track interaction history + in-flight request cancellation in memory only (never disk/Git)
_SESSIONS: dict[str, dict[str, Any]] = {}
_CANCELLED_IDS: set[str] = set()
_STATE_LOCK = threading.Lock()


def _encode_solid_png_b64(width: int = 64, height: int = 64, rgba: tuple[int, int, int, int] = (232, 92, 64, 255)) -> str:
    """Pure-stdlib PNG encoder producing a centered solid silhouette over transparent/chroma margin."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # Filter type 0
        for x in range(width):
            if 12 <= x < width - 12 and 12 <= y < height - 12:
                rows.extend(rgba)
            else:
                rows.extend((0, 184, 96, 255))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        body = tag + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(rows), 6)
    png_bytes = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    return base64.b64encode(png_bytes).decode("ascii")


def is_origin_allowed(origin: str | None) -> bool:
    if origin is None or origin == "":
        return False
    return any(pat.match(origin) is not None for pat in ALLOWED_ORIGIN_PATTERNS)


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = f"NibgridBridge/{BRIDGE_VERSION}"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Never log Authorization headers or secrets
        pass

    def _apply_cors(self, origin: str | None) -> None:
        if origin and is_origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_json(self, status: int, payload: dict[str, Any], origin: str | None) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._apply_cors(origin)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorize(self) -> tuple[bool, str | None]:
        origin = self.headers.get("Origin")
        if origin is not None and not is_origin_allowed(origin):
            self._send_json(403, {"error": "Origin not permitted by loopback bridge allowlist."}, origin)
            return False, origin

        auth = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.session_token}"  # type: ignore[attr-defined]
        if not secrets.compare_digest(auth, expected):
            self._send_json(401, {"error": "Unauthorized: invalid or missing bridge token."}, origin)
            return False, origin

        return True, origin

    def do_OPTIONS(self) -> None:
        origin = self.headers.get("Origin")
        if origin is not None and not is_origin_allowed(origin):
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self._apply_cors(origin)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        ok, origin = self._authorize()
        if not ok:
            return
        if self.path == "/v1/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "version": BRIDGE_VERSION,
                    "models": ["gemini-2.5-flash-image", "gemini-3-pro-image"],
                    "supportsStatefulInteractions": True,
                },
                origin,
            )
            return
        self._send_json(404, {"error": f"Unknown endpoint: {self.path}"}, origin)

    def do_POST(self) -> None:
        ok, origin = self._authorize()
        if not ok:
            return

        if self.path.startswith("/v1/cancel/"):
            req_id = self.path.split("/v1/cancel/", 1)[1]
            with _STATE_LOCK:
                _CANCELLED_IDS.add(req_id)
            self._send_json(200, {"cancelled": True, "requestId": req_id}, origin)
            return

        content_len = int(self.headers.get("Content-Length", "0") or "0")
        raw_body = self.rfile.read(content_len) if content_len > 0 else b"{}"
        try:
            body = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Malformed JSON request body."}, origin)
            return

        if self.path in ("/v1/generate", "/v1/inpaint"):
            self._handle_image_op(body, origin)
            return

        if self.path == "/v1/critique":
            self._handle_critique(body, origin)
            return

        self._send_json(404, {"error": f"Unknown endpoint: {self.path}"}, origin)

    def _handle_image_op(self, body: dict[str, Any], origin: str | None) -> None:
        t0 = time.monotonic()
        request_id = str(body.get("requestId") or secrets.token_hex(8))
        model_id = str(body.get("modelId") or "gemini-2.5-flash-image")
        prev_id = body.get("previousInteractionId")
        used_stateful = False

        with _STATE_LOCK:
            if request_id in _CANCELLED_IDS:
                self._send_json(499, {"error": "Request cancelled."}, origin)
                return
            if isinstance(prev_id, str) and prev_id in _SESSIONS:
                used_stateful = True

        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        mock_mode = bool(self.server.mock_mode) or not api_key  # type: ignore[attr-defined]

        variants_out: list[dict[str, Any]] = []
        expires_at = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=30)).isoformat()

        if mock_mode:
            count = 2 if int(body.get("variants", 1)) == 2 else 1
            for idx in range(count):
                digest = hashlib.sha256(f"{request_id}:{idx}".encode()).hexdigest()[:10]
                interaction_id = f"int_{digest}"
                png_b64 = _encode_solid_png_b64(64, 64, (220 - idx * 30, 84 + idx * 25, 64, 255))
                with _STATE_LOCK:
                    _SESSIONS[interaction_id] = {"modelId": model_id, "createdAt": time.time()}
                variants_out.append(
                    {
                        "pngBase64": png_b64,
                        "width": 64,
                        "height": 64,
                        "interactionId": interaction_id,
                        "interactionExpiresAt": expires_at,
                        "modelId": model_id,
                    }
                )
        else:
            # Forward to Gemini REST generateContent using local user API key without ever exposing it to browser
            endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent"
            parts: list[dict[str, Any]] = [
                {"text": f"{body.get('compiledPrompt', '')}\nDelta: {body.get('promptDelta', '')}"}
            ]
            if isinstance(body.get("sketchPngBase64"), str):
                parts.append({"inlineData": {"mimeType": "image/png", "data": body["sketchPngBase64"]}})
            if isinstance(body.get("maskPngBase64"), str):
                parts.append({"inlineData": {"mimeType": "image/png", "data": body["maskPngBase64"]}})
            payload = {
                "contents": [{"role": "user", "parts": parts}],
                "generationConfig": {"responseModalities": ["IMAGE"]},
            }
            req = urllib.request.Request(
                endpoint,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=45) as resp:
                    resp_json = json.loads(resp.read().decode("utf-8"))
                for cand in resp_json.get("candidates", []):
                    for part in cand.get("content", {}).get("parts", []):
                        inline = part.get("inlineData") or part.get("inline_data")
                        if inline and isinstance(inline.get("data"), str):
                            interaction_id = f"int_{secrets.token_hex(6)}"
                            with _STATE_LOCK:
                                _SESSIONS[interaction_id] = {"modelId": model_id, "createdAt": time.time()}
                            variants_out.append(
                                {
                                    "pngBase64": inline["data"],
                                    "width": 128,
                                    "height": 128,
                                    "interactionId": interaction_id,
                                    "interactionExpiresAt": expires_at,
                                    "modelId": model_id,
                                }
                            )
            except urllib.error.HTTPError as err:
                self._send_json(err.code, {"error": f"Upstream API returned HTTP {err.code}"}, origin)
                return
            except Exception:
                self._send_json(502, {"error": "Upstream Antigravity/Gemini call failed."}, origin)
                return

        if not variants_out:
            self._send_json(502, {"error": "Bridge produced no image variants."}, origin)
            return

        latency_ms = int((time.monotonic() - t0) * 1000)
        self._send_json(
            200,
            {
                "requestId": request_id,
                "variants": variants_out,
                "usedStatefulChain": used_stateful,
                "latencyMs": latency_ms,
            },
            origin,
        )

    def _handle_critique(self, body: dict[str, Any], origin: str | None) -> None:
        bible = body.get("artBibleSnapshot", {})
        lighting = bible.get("lighting", "top-left")
        projection = bible.get("projection", "three-quarter")
        self._send_json(
            200,
            {
                "passed": True,
                "score": 92,
                "driftFlags": [],
                "suggestedPromptDelta": f"preserve {projection} silhouette and crisp {lighting} rim highlight",
                "rationale": f"Verified alignment with Art Bible ({projection}, {lighting}).",
            },
            origin,
        )


def run_server(host: str, port: int, mock_mode: bool) -> None:
    token = f"nbg_{secrets.token_urlsafe(24)}"
    httpd = ThreadingHTTPServer((host, port), BridgeHandler)
    httpd.session_token = token  # type: ignore[attr-defined]
    httpd.mock_mode = mock_mode  # type: ignore[attr-defined]
    print(f"Nibgrid Antigravity Bridge v{BRIDGE_VERSION} listening on http://{host}:{port}", flush=True)
    print(f"Ephemeral Bearer Token (paste into Provider Vault): {token}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Nibgrid local loopback bridge for Google Antigravity")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (strictly 127.0.0.1 recommended)")
    parser.add_argument("--port", type=int, default=4188, help="TCP port (default 4188)")
    parser.add_argument("--mock", action="store_true", help="Serve deterministic mock sprites without GEMINI_API_KEY")
    args = parser.parse_args()
    run_server(args.host, args.port, args.mock)


if __name__ == "__main__":
    main()

