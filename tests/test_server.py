import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


class SpeedTestApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        server.DATABASE = Path(cls.temp_dir.name) / "test.sqlite3"
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.PulseHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.httpd.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()
        cls.temp_dir.cleanup()

    def request(self, path, method="GET", body=None):
        data = None if body is None else json.dumps(body).encode()
        request = Request(self.base_url + path, data=data, method=method)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urlopen(request) as response:
                return response.status, response.read()
        except HTTPError as error:
            with error:
                return error.code, error.read()

    def setUp(self):
        self.request("/api/tests", "DELETE")

    def test_create_list_delete_test(self):
        payload = {
            "download_mbps": 125.5,
            "upload_mbps": 42.25,
            "ping_ms": 16.4,
            "jitter_ms": 2.1,
        }
        status, response = self.request("/api/tests", "POST", payload)
        self.assertEqual(status, 201)
        created = json.loads(response)
        self.assertEqual(created["download_mbps"], payload["download_mbps"])
        self.assertIn("created_at", created)

        status, response = self.request("/api/tests")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(response)[0]["id"], created["id"])

        status, _ = self.request(f"/api/tests/{created['id']}", "DELETE")
        self.assertEqual(status, 204)

        status, response = self.request("/api/tests")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(response), [])

    def test_rejects_negative_or_non_finite_measurements(self):
        for value in (-1, float("nan")):
            payload = {
                "download_mbps": value,
                "upload_mbps": 10,
                "ping_ms": 10,
                "jitter_ms": 1,
            }
            status, response = self.request("/api/tests", "POST", payload)
            self.assertEqual(status, 400)
            self.assertIn(b"error", response)

    def test_rejects_missing_measurement(self):
        status, response = self.request("/api/tests", "POST", {"download_mbps": 10})
        self.assertEqual(status, 400)
        self.assertIn(b"error", response)

    def test_clears_all_tests(self):
        payload = {
            "download_mbps": 10,
            "upload_mbps": 5,
            "ping_ms": 20,
            "jitter_ms": 2,
        }
        self.assertEqual(self.request("/api/tests", "POST", payload)[0], 201)
        self.assertEqual(self.request("/api/tests", "DELETE")[0], 204)
        self.assertEqual(json.loads(self.request("/api/tests")[1]), [])


if __name__ == "__main__":
    unittest.main()
