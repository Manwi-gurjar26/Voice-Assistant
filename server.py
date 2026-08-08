"""Static file host + LiveKit access-token issuer for the Aura web UI."""

from __future__ import annotations

import logging
import os
import uuid

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from livekit import api

load_dotenv()

logger = logging.getLogger("aura.server")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI(title="Aura Voice Assistant", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _websocket_url(raw: str) -> str:
    """LiveKit hands out https:// URLs; the browser SDK needs wss://."""
    url = raw.strip().rstrip("/")
    if url.startswith("https://"):
        return "wss://" + url[len("https://") :]
    if url.startswith("http://"):
        return "ws://" + url[len("http://") :]
    if url.startswith(("wss://", "ws://")):
        return url
    return f"wss://{url}"


@app.get("/api/health")
async def health() -> dict:
    return {
        "ok": True,
        "livekit": bool(os.getenv("LIVEKIT_URL") and os.getenv("LIVEKIT_API_KEY")),
        "deepgram": bool(os.getenv("DEEPGRAM_API_KEY")),
    }


@app.get("/api/token")
async def get_token(room: str | None = None) -> dict:
    # A fresh room per tab. Sharing one room means every open tab plays Aura's
    # voice AND publishes its own mic, so she ends up hearing herself.
    room = (room or "").strip() or f"aura-{uuid.uuid4().hex[:10]}"

    lk_url = os.getenv("LIVEKIT_URL")
    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")

    missing = [
        name
        for name, value in (
            ("LIVEKIT_URL", lk_url),
            ("LIVEKIT_API_KEY", api_key),
            ("LIVEKIT_API_SECRET", api_secret),
        )
        if not value
    ]
    if missing:
        raise HTTPException(
            status_code=500,
            detail=f"Missing environment variables: {', '.join(missing)}. Check your .env file.",
        )

    identity = f"user-{uuid.uuid4().hex[:8]}"
    try:
        token = (
            api.AccessToken(api_key, api_secret)
            .with_identity(identity)
            .with_name("You")
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=room,
                    can_publish=True,
                    can_subscribe=True,
                    can_publish_data=True,
                )
            )
            .to_jwt()
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to mint access token: {exc}") from exc

    return {"token": token, "url": _websocket_url(lk_url), "room": room, "identity": identity}


@app.get("/")
async def index() -> FileResponse:
    index_path = os.path.join(STATIC_DIR, "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail="static/index.html is missing.")
    # No-store keeps the browser from serving a stale UI after edits.
    return FileResponse(index_path, headers={"Cache-Control": "no-store"})


os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    # reload=False on purpose: this process is spawned by main.py, and the
    # reloader forks a child that the launcher cannot see or shut down.
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
