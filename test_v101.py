import base64
import io
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

import app as studio


PNG_B64 = base64.b64encode(b"fake-image").decode()


class V101Tests(unittest.TestCase):
    def setUp(self):
        self.old_config = studio.config
        self.old_output = studio.OUTPUT_DIR
        self.tmp = tempfile.TemporaryDirectory()
        studio.OUTPUT_DIR = Path(self.tmp.name)
        studio.config = {
            "name": "拾光", "theme": "darkroom", "failover_enabled": False,
            "active_provider": "a",
            "providers": [
                {"id": "a", "name": "主线路", "api_base": "https://a.test", "api_key": "test-key-a", "models": ["gpt-image-1"], "health": {"status": "unchecked"}},
                {"id": "b", "name": "备用线路", "api_base": "https://b.test", "api_key": "test-key-b", "models": ["gpt-image-1"], "health": {"status": "unchecked"}},
            ],
        }
        self.client = studio.app.test_client()

    def tearDown(self):
        studio.config = self.old_config
        studio.OUTPUT_DIR = self.old_output
        self.tmp.cleanup()

    def test_capability_matching_and_filtering(self):
        self.assertEqual(studio.capability_for("relay-GPT-IMAGE-2")["key"], "gpt-image")
        self.assertEqual(studio.capability_for("custom-relay-model")["key"], "generic")
        payload = studio._filtered_payload({"prompt": "x", "size": "1024x1024", "quality": "high", "background": "transparent", "style": "vivid", "n": "2"}, "gpt-image-1", studio.capability_for("gpt-image-1"))
        self.assertEqual(payload["quality"], "high")
        self.assertEqual(payload["background"], "transparent")
        self.assertNotIn("style", payload)

    def test_json_generation_and_multipart_edit(self):
        calls = []

        def fake_upstream(path, payload=None, **kwargs):
            calls.append((path, payload))
            return {"data": [{"b64_json": PNG_B64}]}

        def fake_multipart(path, fields, *args, **kwargs):
            calls.append((path, fields))
            return {"data": [{"b64_json": PNG_B64}]}

        with patch.object(studio, "upstream", side_effect=fake_upstream), patch.object(studio, "upstream_multipart", side_effect=fake_multipart), patch.object(studio, "save_config"):
            response = self.client.post("/api/generate", json={"prompt": "a cat", "model": "seedream-5", "size": "1024x1024"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(calls[0][0], "/v1/images/generations")
            response = self.client.post("/api/generate", data={"prompt": "edit", "model": "gpt-image-1", "size": "1024x1024", "image": (io.BytesIO(b"image-bytes"), "ref.png", "image/png")}, content_type="multipart/form-data")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(calls[1][0], "/v1/images/edits")
            self.assertEqual(response.json["mode"], "image-to-image")
            meta = next(studio.OUTPUT_DIR.glob("*.json")).read_text(encoding="utf-8")
            self.assertIn('"reference_used": true', meta)

    def test_reference_validation_and_known_unsupported(self):
        response = self.client.post("/api/generate", data={"prompt": "x", "model": "dall-e-3", "image": (io.BytesIO(b"x"), "ref.txt", "text/plain")}, content_type="multipart/form-data")
        self.assertEqual(response.status_code, 400)
        self.assertIn("仅支持", response.json["error"])
        response = self.client.post("/api/generate", data={"prompt": "x", "model": "dall-e-3", "image": (io.BytesIO(b"x"), "ref.png", "image/png")}, content_type="multipart/form-data")
        self.assertEqual(response.status_code, 400)
        self.assertIn("暂未声明", response.json["error"])

    def test_health_probe_and_safe_failover_once(self):
        with patch.object(studio, "upstream", return_value={"data": []}), patch.object(studio, "save_config"):
            response = self.client.post("/api/providers/health", json={"provider_id": "a", "force": True})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json["providers"][0]["status"], "healthy")

        studio.config["failover_enabled"] = True
        calls = []

        def flaky(path, payload=None, **kwargs):
            calls.append(kwargs["base"])
            if len(calls) == 1:
                raise urllib.error.HTTPError("https://a.test", 503, "down", {}, io.BytesIO())
            return {"data": [{"b64_json": PNG_B64}]}

        with patch.object(studio, "upstream", side_effect=flaky), patch.object(studio, "save_config"):
            response = self.client.post("/api/generate", json={"prompt": "x", "model": "gpt-image-1"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(calls, ["https://a.test", "https://b.test"])
        self.assertTrue(response.json["failover"])

    def test_client_error_does_not_failover(self):
        studio.config["failover_enabled"] = True

        def bad_request(*args, **kwargs):
            raise urllib.error.HTTPError("https://a.test", 400, "bad", {}, io.BytesIO())

        with patch.object(studio, "upstream", side_effect=bad_request), patch.object(studio, "save_config"):
            response = self.client.post("/api/generate", json={"prompt": "x", "model": "gpt-image-1"})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("备用", response.json["error"])


if __name__ == "__main__":
    unittest.main()
