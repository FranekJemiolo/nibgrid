"""Unit and HTTP contract tests for the zero-dependency Nibgrid loopback bridge."""

from __future__ import annotations

import base64
import http.client
import importlib.util
import json
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

BRIDGE_PATH = (
    Path(__file__).resolve().parents[2]
    / ".agents"
    / "skills"
    / "nibgrid"
    / "scripts"
    / "nibgrid_bridge.py"
)

SPEC = importlib.util.spec_from_file_location("nibgrid_bridge_module", BRIDGE_PATH)
assert SPEC is not None and SPEC.loader is not None
nibgrid_bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = nibgrid_bridge
SPEC.loader.exec_module(nibgrid_bridge)


class NibgridLoopbackBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.token = "nbg_test_token_1234567890"
        self.config = nibgrid_bridge.BridgeConfig(
            port=0,
            token=self.token,
            allowed_origins=nibgrid_bridge.DEFAULT_ALLOWED_ORIGINS,
            mock=True,
            gemini_api_key="AIzaDummyKeyShouldNeverLeak12345",
        )
        handler = nibgrid_bridge.make_handler(self.config)
        self.httpd = ThreadingHTTPServer(
            (nibgrid_bridge.DEFAULT_HOST, 0), handler
        )
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(
            target=self.httpd.serve_forever, daemon=True
        )
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def _request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        body: bytes | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            raw = resp.read()
            resp_headers = {k.lower(): v for k, v in resp.getheaders()}
            return resp.status, resp_headers, raw
        finally:
            conn.close()

    def test_health_unauthenticated_returns_200_with_pna_headers(self) -> None:
        status, headers, raw = self._request(
            "GET",
            "/v1/health",
            headers={"Origin": "https://franekjemiolo.github.io"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            headers.get("access-control-allow-origin"),
            "https://franekjemiolo.github.io",
        )
        self.assertEqual(
            headers.get("access-control-allow-private-network"), "true"
        )
        data = json.loads(raw.decode("utf-8"))
        self.assertEqual(data["status"], "ok")
        self.assertTrue(data["ok"])
        self.assertTrue(data["mock"])
        self.assertTrue(data["authRequired"])

    def test_disallowed_origin_returns_403(self) -> None:
        for origin in ("https://evil.example", "http://localhost:9999"):
            status_get, _, _ = self._request(
                "GET", "/v1/health", headers={"Origin": origin}
            )
            self.assertEqual(status_get, 403)
            status_opt, _, _ = self._request(
                "OPTIONS", "/v1/image/generate", headers={"Origin": origin}
            )
            self.assertEqual(status_opt, 403)
            status_post, _, _ = self._request(
                "POST",
                "/v1/image/generate",
                headers={
                    "Origin": origin,
                    "Authorization": f"Bearer {self.token}",
                    "Content-Type": "application/json",
                },
                body=b"{}",
            )
            self.assertEqual(status_post, 403)

    def test_options_pna_preflight_headers(self) -> None:
        status, headers, _ = self._request(
            "OPTIONS",
            "/v1/image/generate",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        self.assertEqual(status, 204)
        self.assertEqual(
            headers.get("access-control-allow-origin"), "http://localhost:5173"
        )
        self.assertEqual(
            headers.get("access-control-allow-private-network"), "true"
        )
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertIn("Origin", headers.get("vary", ""))

    def test_post_requires_valid_bearer_token(self) -> None:
        for auth in ({}, {"Authorization": "Bearer wrong_token"}):
            status, _, _ = self._request(
                "POST",
                "/v1/image/generate",
                headers={
                    "Origin": "http://127.0.0.1:5173",
                    "Content-Type": "application/json",
                    **auth,
                },
                body=b'{"prompt":"knight"}',
            )
            self.assertEqual(status, 401)

    def test_mock_image_generate_and_inpaint_return_valid_png(self) -> None:
        for route in ("/v1/image/generate", "/v1/image/inpaint"):
            status, _, raw = self._request(
                "POST",
                route,
                headers={
                    "Origin": "http://localhost:4173",
                    "Authorization": f"Bearer {self.token}",
                    "Content-Type": "application/json",
                },
                body=json.dumps(
                    {"prompt": "mossy stone", "width": 16, "height": 16}
                ).encode("utf-8"),
            )
            self.assertEqual(status, 200)
            data = json.loads(raw.decode("utf-8"))
            self.assertTrue(data["mock"])
            self.assertEqual(data["mimeType"], "image/png")
            png_bytes = base64.b64decode(data["imageBase64"])
            self.assertTrue(png_bytes.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_mock_audio_generate_returns_valid_wav(self) -> None:
        status, _, raw = self._request(
            "POST",
            "/v1/audio/generate",
            headers={
                "Origin": "http://127.0.0.1:4173",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            body=json.dumps({"durationSeconds": 0.1, "frequencyHz": 660}).encode(
                "utf-8"
            ),
        )
        self.assertEqual(status, 200)
        data = json.loads(raw.decode("utf-8"))
        self.assertTrue(data["mock"])
        self.assertEqual(data["mimeType"], "audio/wav")
        wav_bytes = base64.b64decode(data["audioBase64"])
        self.assertTrue(wav_bytes.startswith(b"RIFF"))
        self.assertEqual(wav_bytes[8:12], b"WAVE")

    def test_mock_llm_json_and_vision_qa(self) -> None:
        status_llm, _, raw_llm = self._request(
            "POST",
            "/v1/llm/json",
            headers={
                "Origin": "http://localhost:5173",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            body=b'{"prompt":"room blueprint"}',
        )
        self.assertEqual(status_llm, 200)
        llm_data = json.loads(raw_llm.decode("utf-8"))
        self.assertTrue(llm_data["mock"])
        self.assertTrue(llm_data["json"]["ok"])

        status_qa, _, raw_qa = self._request(
            "POST",
            "/v1/vision/qa",
            headers={
                "Origin": "http://localhost:5173",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            body=b'{"prompt":"check palette"}',
        )
        self.assertEqual(status_qa, 200)
        qa_data = json.loads(raw_qa.decode("utf-8"))
        self.assertEqual(qa_data["overallScore"], 92)
        self.assertEqual(qa_data["findings"], [])

    def test_malformed_json_and_oversized_content_length_return_400(self) -> None:
        status_bad_json, _, _ = self._request(
            "POST",
            "/v1/llm/json",
            headers={
                "Origin": "http://localhost:5173",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            body=b"{not-valid-json",
        )
        self.assertEqual(status_bad_json, 400)

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            oversized = nibgrid_bridge.MAX_BODY_BYTES + 1
            conn.putrequest("POST", "/v1/image/generate")
            conn.putheader("Origin", "http://localhost:5173")
            conn.putheader("Authorization", f"Bearer {self.token}")
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", str(oversized))
            conn.endheaders()
            resp = conn.getresponse()
            resp.read()
            self.assertEqual(resp.status, 400)
        finally:
            conn.close()

    def test_redact_secrets_and_defaults(self) -> None:
        sample = (
            "Failed with AIzaSyAbCdEfGhIjKlMnOpQrStUv "
            "sk-proj-1234567890abcdef nbg_secret_token_999 Bearer supersecret "
            "and custom_secret_val"
        )
        redacted = nibgrid_bridge.redact_secrets(
            sample, ("custom_secret_val",)
        )
        self.assertNotIn("AIzaSy", redacted)
        self.assertNotIn("sk-proj", redacted)
        self.assertNotIn("nbg_secret_token_999", redacted)
        self.assertNotIn("supersecret", redacted)
        self.assertNotIn("custom_secret_val", redacted)
        self.assertEqual(nibgrid_bridge.DEFAULT_HOST, "127.0.0.1")
        self.assertEqual(nibgrid_bridge.DEFAULT_PORT, 4188)

        parsed = nibgrid_bridge.parse_args(
            ["--mock", "--port", "4199", "--allow-origin", "https://custom.dev"]
        )
        self.assertTrue(parsed.mock)
        self.assertEqual(parsed.port, 4199)
        self.assertIn("https://custom.dev", parsed.allow_origin)


if __name__ == "__main__":
    unittest.main()
