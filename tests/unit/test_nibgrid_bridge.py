import http.client
import importlib.util
import json
import sys
import threading
import unittest
from pathlib import Path

SCRIPT_PATH = (
    Path(__file__).resolve().parents[2]
    / ".agents"
    / "skills"
    / "nibgrid"
    / "scripts"
    / "nibgrid_bridge.py"
)

_SPEC = importlib.util.spec_from_file_location("nibgrid_bridge", SCRIPT_PATH)
assert _SPEC is not None and _SPEC.loader is not None
nibgrid_bridge = importlib.util.module_from_spec(_SPEC)
sys.modules["nibgrid_bridge"] = nibgrid_bridge
_SPEC.loader.exec_module(nibgrid_bridge)


class NibgridBridgeSecurityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.token = "nbg_unit_test_secret_token_987654"
        self.server = nibgrid_bridge.create_bridge_server(
            "127.0.0.1", 0, mock_mode=True, token=self.token
        )
        self.port = int(self.server.server_address[1])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_refuses_non_loopback_bind(self) -> None:
        with self.assertRaises(ValueError):
            nibgrid_bridge.create_bridge_server("0.0.0.0", 0, mock_mode=True, token=self.token)
        with self.assertRaises(ValueError):
            nibgrid_bridge.create_bridge_server("192.168.1.50", 0, mock_mode=True, token=self.token)

    def test_missing_or_invalid_bearer_token_returns_401(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(
                "GET",
                "/v1/health",
                headers={"Origin": "https://franekjemiolo.github.io"},
            )
            resp = conn.getresponse()
            body = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(resp.status, 401)
            self.assertIn("Unauthorized", body["error"])
            self.assertNotIn(self.token, json.dumps(body))

            conn.request(
                "GET",
                "/v1/health",
                headers={
                    "Origin": "https://franekjemiolo.github.io",
                    "Authorization": "Bearer wrong_token_value",
                },
            )
            resp2 = conn.getresponse()
            resp2.read()
            self.assertEqual(resp2.status, 401)
        finally:
            conn.close()

    def test_disallowed_origin_returns_403(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(
                "GET",
                "/v1/health",
                headers={
                    "Origin": "https://evil.example",
                    "Authorization": f"Bearer {self.token}",
                },
            )
            resp = conn.getresponse()
            resp.read()
            self.assertEqual(resp.status, 403)
        finally:
            conn.close()

    def test_options_pna_preflight_sets_private_network_header(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(
                "OPTIONS",
                "/v1/generate",
                headers={
                    "Origin": "https://franekjemiolo.github.io",
                    "Access-Control-Request-Private-Network": "true",
                },
            )
            resp = conn.getresponse()
            resp.read()
            self.assertEqual(resp.status, 204)
            self.assertEqual(
                resp.getheader("Access-Control-Allow-Origin"),
                "https://franekjemiolo.github.io",
            )
            self.assertEqual(
                resp.getheader("Access-Control-Allow-Private-Network"),
                "true",
            )
        finally:
            conn.close()

    def test_rejects_payload_exceeding_25mb_with_413(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            # Send headers manually with oversized Content-Length before reading body
            conn.putrequest("POST", "/v1/generate")
            conn.putheader("Origin", "https://franekjemiolo.github.io")
            conn.putheader("Authorization", f"Bearer {self.token}")
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", str(25 * 1024 * 1024 + 1))
            conn.endheaders()

            resp = conn.getresponse()
            body = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(resp.status, 413)
            self.assertIn("25 MB", body["error"])
        finally:
            conn.close()

    def test_valid_generate_and_stateful_interaction_chain(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            payload1 = json.dumps(
                {
                    "requestId": "req_1",
                    "compiledPrompt": "red cat knight",
                    "promptDelta": "",
                    "variants": 1,
                }
            ).encode("utf-8")
            conn.request(
                "POST",
                "/v1/generate",
                body=payload1,
                headers={
                    "Origin": "http://localhost:5173",
                    "Authorization": f"Bearer {self.token}",
                    "Content-Type": "application/json",
                },
            )
            resp1 = conn.getresponse()
            data1 = json.loads(resp1.read().decode("utf-8"))
            self.assertEqual(resp1.status, 200)
            self.assertFalse(data1["usedStatefulChain"])
            first_int = data1["variants"][0]["interactionId"]
            self.assertTrue(first_int.startswith("int_"))

            payload2 = json.dumps(
                {
                    "requestId": "req_2",
                    "compiledPrompt": "red cat knight",
                    "promptDelta": "green visor",
                    "previousInteractionId": first_int,
                    "variants": 1,
                }
            ).encode("utf-8")
            conn.request(
                "POST",
                "/v1/generate",
                body=payload2,
                headers={
                    "Origin": "http://localhost:5173",
                    "Authorization": f"Bearer {self.token}",
                    "Content-Type": "application/json",
                },
            )
            resp2 = conn.getresponse()
            data2 = json.loads(resp2.read().decode("utf-8"))
            self.assertEqual(resp2.status, 200)
            self.assertTrue(data2["usedStatefulChain"])
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()

