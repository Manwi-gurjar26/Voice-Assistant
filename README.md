# Aura — Realtime AI Voice Assistant

Aura is a browser-based voice assistant you talk to out loud. Press the mic,
speak, and she listens, thinks, and replies — with sub-second turn-taking,
barge-in interruption, and a live transcript on screen the whole time.

```
You speak  →  Deepgram STT  →  LLM (Gemini / OpenAI)  →  Deepgram TTS  →  Aura speaks
                    ↑                                            │
                    └──────────── Silero VAD (turn detection) ───┘
```

## Features

- **Realtime voice loop** over [LiveKit](https://livekit.io) — streaming speech-to-text, an LLM reply, and streaming text-to-speech, glued together with sub-second turn detection (Silero VAD).
- **Barge-in interruption** — talk over Aura and she stops, listens, and picks the conversation back up.
- **Live transcript** — every line either of you says appears in the browser as it's spoken, over a LiveKit data channel.
- **Automatic LLM fallback** — tries Gemini and OpenAI in order, probes each with a live request at startup, and falls back to a small rule-based offline responder if neither is reachable, so the app never just dies.
- **3D audio-reactive orb** — a Three.js icosahedron, vertex-displaced by simplex noise, whose amplitude and color follow your mic level and Aura's voice in real time. Falls back to a flat 2D pulse automatically if WebGL is unavailable or the browser prefers reduced motion.
- **A real multi-section site**, not just a widget: sticky nav (Talk / How it works / Speed / Privacy), a live latency breakdown, and a plain-language privacy section — all built in dependency-free HTML/CSS/JS.

## Architecture

| Piece | File | Role |
|---|---|---|
| Orchestrator | `main.py` | Single entry point. Checks `.env`, starts the web server and the agent worker as subprocesses, opens your browser, and shuts both down together on Ctrl+C. |
| Web server | `server.py` | FastAPI app. Serves `static/` and mints short-lived LiveKit access tokens at `/api/token` — one fresh room per browser tab. |
| Voice agent | `agent.py` | A LiveKit Agents worker. Builds the STT → LLM → TTS pipeline, handles turn-taking/interruption, and mirrors every transcript and state change to the browser over a LiveKit data channel (topic `"aura"`). |
| Frontend | `static/` | Plain HTML/CSS/JS — no build step, no framework. `app.js` drives the LiveKit client, the 3D orb, and the conversation UI. |

The browser never talks to the LLM/STT/TTS providers directly — it only holds a
LiveKit room connection. All provider credentials stay server-side in `agent.py`.

## Requirements

- Python 3.10+
- A [LiveKit Cloud](https://cloud.livekit.io) project (free tier is fine)
- A [Deepgram](https://console.deepgram.com) API key (speech-to-text + text-to-speech)
- An [OpenAI](https://platform.openai.com/api-keys) or [Gemini](https://aistudio.google.com/apikey) API key (Gemini has a free tier)

## Setup

**1. Create a virtual environment and install dependencies**

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS/Linux

pip install -r requirements.txt
```

**2. Configure your keys**

```bash
copy .env.example .env        # Windows
# cp .env.example .env        # macOS/Linux
```

Open `.env` and fill in:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — from your LiveKit Cloud project settings
- `DEEPGRAM_API_KEY` — powers both speech-to-text and text-to-speech
- `OPENAI_API_KEY` and/or `GEMINI_API_KEY` — at least one, for real answers (without either, Aura runs on a limited offline responder)

**3. Run it**

```bash
python main.py
```

This starts the web server, starts the voice agent worker, and opens
`http://127.0.0.1:8000` in your browser automatically. Click the mic, allow
microphone access, and talk. Press Ctrl+C in the terminal to stop everything.

## Project structure

```
main.py            Launches server.py + agent.py together, preflight-checks .env
server.py           FastAPI: serves static/, issues LiveKit tokens
agent.py            LiveKit Agents worker: STT -> LLM -> TTS pipeline
requirements.txt    Pinned to the LiveKit Agents 1.x API
.env.example         Template for your own .env (never commit the real one)
static/
  index.html         Markup: nav, hero (orb + conversation), content sections
  style.css           All styling, incl. the 3D orb container and reveal animations
  app.js               LiveKit client, 3D orb renderer, chat rendering, UI polish
```

## How the pipeline stays fast

- **Turn detection** runs on Silero VAD with `preemptive_generation` enabled, so the LLM starts drafting a reply before you've fully finished speaking.
- **Interruption** requires at least 2 words and 400ms of real speech before cutting Aura off, so background noise or her own speaker bleed doesn't falsely interrupt her.
- **LLM fallback** (`llm.FallbackAdapter`) means a single provider outage degrades to the offline responder instead of taking the whole session down.
- The **Reply** chip in the UI shows your actual measured turn latency (mic stop → Aura speaking) for every exchange, live.

## Troubleshooting

- **"Missing in .env"** on startup — one of the required LiveKit/Deepgram keys is empty or still the placeholder value from `.env.example`.
- **Aura answers but sounds robotic/echoes herself** — check that `echoCancellation` isn't disabled by your OS input settings; the browser client already turns it on by default.
- **No cloud language model is reachable** toast — both OpenAI and Gemini failed their startup health check (bad key, no quota, or network). Aura keeps running on the offline responder until you fix `.env`.
- **Mic button does nothing** — open the browser console; the app requires a real user gesture to request microphone permission, so it must be a direct click.
