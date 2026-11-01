"""Check the Bazel-built server on its default port and an alternate port."""
import os
from pathlib import Path
import subprocess
import time
import urllib.request

binary = Path("bazel-bin/helloworld_/helloworld").resolve()
for port in (8080, 18080):
    env = os.environ.copy()
    env.pop("PORT", None)
    if port != 8080:
        env["PORT"] = str(port)
    process = subprocess.Popen([str(binary)], env=env, stderr=subprocess.PIPE)
    try:
        for attempt in range(100):
            if process.poll() is not None:
                raise RuntimeError(process.stderr.read().decode())
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1) as response:
                    assert response.status == 200
                    assert response.headers.get_content_type() == "text/plain"
                    assert response.read() == b"Hello world from remote Codex"
                # Ensure a different server did not answer after ours failed to bind.
                assert process.poll() is None, "Server exited unexpectedly"
                print(f"PASS: HTTP response on port {port}")
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError(f"Server did not become ready on port {port}")
    finally:
        process.terminate()
        process.wait(timeout=5)
        process.stderr.close()
