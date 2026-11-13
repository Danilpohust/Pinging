import json
import math
import os
import sqlite3
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
DATABASE = Path(os.environ.get("PULSE_DATABASE", ROOT / "data" / "pulse.sqlite3"))
MAX_REQUEST_SIZE = 16 * 1024
MEASUREMENT_FIELDS = ("download_mbps", "upload_mbps", "ping_ms", "jitter_ms")


def connect_database():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """CREATE TABLE IF NOT EXISTS speed_tests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            download_mbps REAL NOT NULL,
            upload_mbps REAL NOT NULL,
            ping_ms REAL NOT NULL,
            jitter_ms REAL NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"""
    )
    return connection


@contextmanager
def database_connection():
    connection = connect_database()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def test_json(row):
    return {key: row[key] for key in ("id", *MEASUREMENT_FIELDS, "created_at")}


class PulseHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status, payload=None):
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None, "Invalid content length", 400
        if length <= 0:
            return None, "Request body is required", 400
        if length > MAX_REQUEST_SIZE:
            return None, "Request body is too large", 413
        try:
            data = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None, "Request body must be valid JSON", 400
        if not isinstance(data, dict):
            return None, "Request body must be a JSON object", 400
        values = []
        for field in MEASUREMENT_FIELDS:
            value = data.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return None, f"{field} must be a number", 400
            value = float(value)
            if not math.isfinite(value) or value < 0:
                return None, f"{field} must be a finite non-negative number", 400
            if value > 1_000_000:
                return None, f"{field} is outside the supported range", 400
            values.append(value)
        return values, None, None

    def do_GET(self):
        if urlparse(self.path).path == "/api/tests":
            with database_connection() as connection:
                rows = connection.execute(
                    "SELECT id, download_mbps, upload_mbps, ping_ms, jitter_ms, created_at "
                    "FROM speed_tests ORDER BY id DESC LIMIT 50"
                ).fetchall()
            return self.send_json(200, [test_json(row) for row in rows])
        return super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path != "/api/tests":
            return self.send_json(404, {"error": "Not found"})
        values, error, status = self.read_json()
        if error:
            return self.send_json(status, {"error": error})
        with database_connection() as connection:
            cursor = connection.execute(
                "INSERT INTO speed_tests (download_mbps, upload_mbps, ping_ms, jitter_ms) "
                "VALUES (?, ?, ?, ?)",
                values,
            )
            row = connection.execute(
                "SELECT id, download_mbps, upload_mbps, ping_ms, jitter_ms, created_at "
                "FROM speed_tests WHERE id = ?",
                (cursor.lastrowid,),
            ).fetchone()
        return self.send_json(201, test_json(row))

    def do_DELETE(self):
        path = unquote(urlparse(self.path).path)
        if path == "/api/tests":
            with database_connection() as connection:
                connection.execute("DELETE FROM speed_tests")
            return self.send_json(204)
        prefix = "/api/tests/"
        if path.startswith(prefix):
            test_id = path[len(prefix):]
            if not test_id.isdigit():
                return self.send_json(400, {"error": "Invalid test id"})
            with database_connection() as connection:
                cursor = connection.execute("DELETE FROM speed_tests WHERE id = ?", (int(test_id),))
            if not cursor.rowcount:
                return self.send_json(404, {"error": "Test not found"})
            return self.send_json(204)
        return self.send_json(404, {"error": "Not found"})

    def log_message(self, format_string, *args):
        print("%s - %s" % (self.address_string(), format_string % args))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    connect_database().close()
    httpd = ThreadingHTTPServer(("0.0.0.0", port), PulseHandler)
    print(f"Pulse is listening on port {port}")
    httpd.serve_forever()
