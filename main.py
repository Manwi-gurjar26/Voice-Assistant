"""Single entry point: starts the web server and the LiveKit agent worker together.

    python main.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser

from dotenv import load_dotenv

load_dotenv()

# The Windows console defaults to a legacy codepage (cp1252/cp437) that can't
# encode a lot of what the agent's logger writes (arrows, box-drawing, the
# U+FFFD replacement character from a decode hiccup upstream). Force UTF-8 on
# stdout/stderr so say() never crashes the launcher over a single log line.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = os.getenv("PORT", "8000").strip() or "8000"
URL = f"http://127.0.0.1:{PORT}"

processes: list[subprocess.Popen] = []
_shutting_down = False


def say(message: str = "") -> None:
    print(message, flush=True)


def preflight() -> bool:
    """Check the credentials that must exist before anything can work."""
    required = ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")
    missing = [name for name in required if not (os.getenv(name) or "").strip()]
    if missing:
        say(f"  [x] Missing in .env: {', '.join(missing)}")
        return False
    say("  [ok] LiveKit credentials found")

    if (os.getenv("DEEPGRAM_API_KEY") or "").strip():
        say("  [ok] Deepgram key found (speech to text + text to speech)")
    elif (os.getenv("OPENAI_API_KEY") or "").strip():
        say("  [!] No Deepgram key - falling back to OpenAI speech")
    else:
        say("  [x] No DEEPGRAM_API_KEY or OPENAI_API_KEY - Aura cannot hear or speak")
        return False

    if not (os.getenv("OPENAI_API_KEY") or os.getenv("GEMINI_API_KEY") or "").strip():
        say("  [!] No LLM key set - Aura will use its limited offline brain")
    return True


def spawn(script: str, *args: str) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-u", os.path.join(BASE_DIR, script), *args],
        cwd=BASE_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )


def stream_output(proc: subprocess.Popen, label: str) -> None:
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            say(f"  {label} | {line}")


def wait_for_server(timeout: float = 25.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{URL}/api/health", timeout=2):
                return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.4)
    return False


def shutdown(code: int = 0) -> None:
    global _shutting_down
    if _shutting_down:
        return
    _shutting_down = True

    say()
    say("Shutting down Aura...")
    for proc in processes:
        if proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
    for proc in processes:
        try:
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    say("Stopped. Goodbye!")
    sys.exit(code)


def main() -> None:
    say("=" * 62)
    say("  AURA - Realtime AI Voice Assistant")
    say("=" * 62)

    say("Checking configuration...")
    if not preflight():
        say()
        say("Fix the items marked [x] in your .env file, then run this again.")
        sys.exit(1)

    say()
    say("Starting web server...")
    server = spawn("server.py")
    processes.append(server)
    threading.Thread(target=stream_output, args=(server, "server"), daemon=True).start()

    if not wait_for_server():
        say("  [x] Web server did not come up in time.")
        shutdown(1)
    say(f"  [ok] Web server listening on {URL}")

    say("Starting voice agent worker...")
    # --log-level info keeps the console readable; DEBUG is the CLI default.
    agent = spawn("agent.py", "dev", "--log-level", "info")
    processes.append(agent)
    threading.Thread(target=stream_output, args=(agent, "agent ", ), daemon=True).start()

    say()
    say("-" * 62)
    say(f"  Aura is ready  ->  {URL}")
    say("  Click the microphone, allow the mic prompt, and start talking.")
    say("  Press CTRL+C here to stop everything.")
    say("-" * 62)
    say()

    try:
        webbrowser.open(URL)
    except Exception:
        pass

    try:
        while True:
            for proc, name in zip(processes, ("web server", "agent worker")):
                if proc.poll() is not None:
                    say()
                    say(f"[!] The {name} exited with code {proc.returncode}.")
                    shutdown(1)
            time.sleep(0.5)
    except KeyboardInterrupt:
        shutdown(0)


if __name__ == "__main__":
    main()
