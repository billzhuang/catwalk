"""Characterization tests for server.py's Azure HTTP helpers.

Pins the current behavior of azure_json / azure_bytes / azure_multipart on
error responses (JSON body, non-JSON body, and generic exceptions) before a
behavior-preserving refactor that de-duplicates the error-body parsing.
"""
import importlib
import os
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

FIXTURE_ENV = """
# east-us-2
apikey=fakekey2
openapi_endpoint=https://fake2.openai.azure.com/openai/v1

# east-us-1
apikey=fakekey1
openapi_endpoint=https://fake1.openai.azure.com/openai/v1
"""


class ServerAzureHelpersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fd, path = tempfile.mkstemp(suffix=".sh")
        with os.fdopen(fd, "w") as fh:
            fh.write(FIXTURE_ENV)
        cls._env_path = path
        os.environ["AIFOUNDRY_ENV"] = path
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        cls.server = importlib.import_module("server")

    @classmethod
    def tearDownClass(cls):
        os.remove(cls._env_path)

    def _http_error(self, code, body_bytes):
        return urllib.error.HTTPError(
            url="https://example.test", code=code, msg="err",
            hdrs=None, fp=__import__("io").BytesIO(body_bytes),
        )

    def test_azure_json_http_error_with_json_body(self):
        err = self._http_error(400, b'{"error": {"message": "bad request"}}')
        with mock.patch("urllib.request.urlopen", side_effect=err):
            status, body = self.server.azure_json("chat/completions", {})
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": {"message": "bad request"}})

    def test_azure_json_http_error_with_non_json_body(self):
        err = self._http_error(500, b"internal server error, not json")
        with mock.patch("urllib.request.urlopen", side_effect=err):
            status, body = self.server.azure_json("chat/completions", {})
        self.assertEqual(status, 500)
        self.assertEqual(body, {"error": {"message": "internal server error, not json"}})

    def test_azure_json_generic_exception(self):
        with mock.patch("urllib.request.urlopen", side_effect=OSError("boom")):
            status, body = self.server.azure_json("chat/completions", {})
        self.assertEqual(status, 0)
        self.assertEqual(body, {"error": {"message": "boom"}})

    def test_azure_bytes_http_error_with_json_body(self):
        err = self._http_error(429, b'{"error": {"message": "rate limited"}}')
        with mock.patch("urllib.request.urlopen", side_effect=err):
            status, body, ctype = self.server.azure_bytes("audio/tts", {})
        self.assertEqual(status, 429)
        self.assertEqual(body, {"error": {"message": "rate limited"}})
        self.assertEqual(ctype, "application/json")

    def test_azure_bytes_http_error_with_non_json_body(self):
        err = self._http_error(503, b"service unavailable")
        with mock.patch("urllib.request.urlopen", side_effect=err):
            status, body, ctype = self.server.azure_bytes("audio/tts", {})
        self.assertEqual(status, 503)
        self.assertEqual(body, {"error": {"message": "service unavailable"}})
        self.assertEqual(ctype, "application/json")

    def test_azure_bytes_generic_exception(self):
        with mock.patch("urllib.request.urlopen", side_effect=OSError("boom")):
            status, body, ctype = self.server.azure_bytes("audio/tts", {})
        self.assertEqual(status, 0)
        self.assertEqual(body, {"error": {"message": "boom"}})
        self.assertEqual(ctype, "application/json")

    def test_azure_multipart_http_error_with_json_body(self):
        err = self._http_error(400, b'{"error": {"message": "bad file"}}')
        with mock.patch("urllib.request.urlopen", side_effect=err):
            status, body = self.server.azure_multipart(
                "audio/transcriptions", {}, "file", "a.wav", b"\x00\x00", "audio/wav",
            )
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": {"message": "bad file"}})

    def test_azure_multipart_http_error_with_non_json_body(self):
        err = self._http_error(413, b"payload too large")
        with mock.patch("urllib.request.urlopen", side_effect=err):
            status, body = self.server.azure_multipart(
                "audio/transcriptions", {}, "file", "a.wav", b"\x00\x00", "audio/wav",
            )
        self.assertEqual(status, 413)
        self.assertEqual(body, {"error": {"message": "payload too large"}})

    def test_azure_multipart_generic_exception(self):
        with mock.patch("urllib.request.urlopen", side_effect=OSError("boom")):
            status, body = self.server.azure_multipart(
                "audio/transcriptions", {}, "file", "a.wav", b"\x00\x00", "audio/wav",
            )
        self.assertEqual(status, 0)
        self.assertEqual(body, {"error": {"message": "boom"}})


if __name__ == "__main__":
    unittest.main()
