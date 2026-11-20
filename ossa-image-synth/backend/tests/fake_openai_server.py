"""Minimal local stand-in for the OpenAI REST API, used ONLY by the end-to-end browser test.

Run:  python tests/fake_openai_server.py 8099
Then start the backend with OPENAI_BASE_URL=http://127.0.0.1:8099/v1 OPENAI_API_KEY=sk-test-e2e
It is never used by the application itself.
"""
import base64
import io
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
from PIL import Image


class H(BaseHTTPRequestHandler):
    def _send(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.endswith("/models"):
            return self._send(200, {"data": [{"id": m} for m in ["gpt-image-1", "gpt-image-1-mini", "dall-e-2", "gpt-4.1"]]})
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0))).decode("latin-1")
        if self.path.endswith("/images/edits"):
            w, h = (int(v) for v in re.search(r'name="size"\r\n\r\n([0-9x]+)', body).group(1).split("x"))
            arr = np.zeros((h, w, 3), np.uint8)
            arr[...] = (150, 105, 62)
            for x in range(0, w, 24):
                arr[:, x:x + 3] = (118, 80, 45)  # wood-grain-like stripes
            buf = io.BytesIO()
            Image.fromarray(arr).save(buf, "PNG")
            return self._send(200, {"created": 1, "data": [{"b64_json": base64.b64encode(buf.getvalue()).decode()}], "usage": {}})
        self._send(404, {"error": {"message": "not found"}})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8099), H).serve_forever()
