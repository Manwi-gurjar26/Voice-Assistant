"""Aura — a realtime voice assistant built on LiveKit Agents 1.x.

Pipeline:  Deepgram STT (nova-3)  ->  LLM  ->  Deepgram TTS (aura-2)
Turn taking is handled by Silero VAD.

Every transcript and state change is mirrored to the browser over the LiveKit
data channel on the "aura" topic, so the web UI can render the conversation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import time
from datetime import datetime
from typing import Any

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    TurnHandlingOptions,
    WorkerOptions,
    cli,
    llm,
    room_io,
)
from livekit.agents.llm import ChatChunk, ChatContext, ChoiceDelta
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN, APIConnectOptions

try:
    from livekit.plugins import silero
except ImportError:  # pragma: no cover
    silero = None

try:
    from livekit.plugins import deepgram
except ImportError:  # pragma: no cover
    deepgram = None

try:
    from livekit.plugins import openai as openai_plugin
except ImportError:  # pragma: no cover
    openai_plugin = None

try:
    from livekit.plugins import google as google_plugin
except ImportError:  # pragma: no cover
    google_plugin = None

load_dotenv()

# The LiveKit CLI installs its own root handler, so adding one here (via
# basicConfig) would print every line twice. Just name our logger and let the
# CLI's `--log-level` decide the verbosity.
logger = logging.getLogger("aura")
logger.setLevel(logging.INFO)

# Quieten third-party chatter so the console stays readable.
for _noisy in (
    "openai",
    "httpx",
    "httpcore",
    "urllib3",
    "asyncio",
    "numba",
    "torch",
    "google_genai",
    "google_genai.models",
):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

DATA_TOPIC = "aura"

# (model, thinking_config) tried in order, fastest first — a voice assistant
# lives or dies on latency. Measured end-to-end on 2026-07-27:
#   gemini-flash-lite-latest  ~0.8s
#   gemini-3-flash-preview    ~1.7s  (needs thinking_level, see below)
# Do NOT pass thinking_budget to the "-latest" aliases: they resolve to Gemini 3
# models that reject it with HTTP 400. Gemini 3 wants thinking_level instead,
# and leaving it unset lets full reasoning run — that cost 12s per reply.
GEMINI_MODELS: tuple[tuple[str, dict | None], ...] = (
    ("gemini-flash-lite-latest", None),
    ("gemini-3-flash-preview", {"thinking_level": "low"}),
    ("gemini-flash-latest", None),
    ("gemini-2.0-flash", None),
)

INSTRUCTIONS = (
    "You are Aura, a warm and capable personal voice assistant. "
    "You are speaking out loud, so keep answers short and conversational — "
    "usually one or two sentences, never more than three. "
    "Do not use markdown, bullet points, emoji, or special formatting. "
    "Spell out numbers and units the way a person would say them. "
    "If you do not know something, say so plainly instead of guessing."
)

PLACEHOLDER_VALUES = {
    "",
    "none",
    "your_deepgram_api_key",
    "your_openai_api_key",
    "your_gemini_api_key",
    "your_google_api_key",
    "sk-...",
}


def _clean_key(name: str) -> str | None:
    """Return an env var only if it holds something that looks like a real key."""
    value = (os.getenv(name) or "").strip().strip('"').strip("'")
    if value.lower() in PLACEHOLDER_VALUES:
        return None
    return value or None


# --------------------------------------------------------------------------- #
# Offline fallback LLM
# --------------------------------------------------------------------------- #


class _OfflineStream(llm.LLMStream):
    """Emits a canned reply as a normal streaming LLM response."""

    def __init__(
        self,
        owner: llm.LLM,
        chat_ctx: ChatContext,
        reply: str,
        conn_options: APIConnectOptions,
    ) -> None:
        super().__init__(llm=owner, chat_ctx=chat_ctx, tools=[], conn_options=conn_options)
        self._reply = reply

    async def _run(self) -> None:
        # Stream in small pieces so TTS can start speaking immediately.
        for word in self._reply.split(" "):
            self._event_ch.send_nowait(
                ChatChunk(
                    id="aura-offline",
                    delta=ChoiceDelta(role="assistant", content=word + " "),
                )
            )
            await asyncio.sleep(0)


class OfflineLLM(llm.LLM):
    """A tiny rule-based responder.

    This is the safety net that keeps Aura talking when no cloud LLM is
    reachable (missing key, exhausted quota, network down). It implements the
    full `llm.LLM.chat` signature — the previous version omitted `tool_choice`,
    which made every single reply raise TypeError before it ever reached TTS.
    """

    @property
    def model(self) -> str:
        return "aura-offline"

    @property
    def provider(self) -> str:
        return "local"

    def chat(
        self,
        *,
        chat_ctx: ChatContext,
        tools: list[Any] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        parallel_tool_calls: Any = NOT_GIVEN,
        tool_choice: Any = NOT_GIVEN,
        extra_kwargs: Any = NOT_GIVEN,
    ) -> llm.LLMStream:
        return _OfflineStream(self, chat_ctx, self._reply_for(chat_ctx), conn_options)

    @staticmethod
    def _last_user_text(chat_ctx: ChatContext) -> str:
        for item in reversed(list(chat_ctx.items)):
            if getattr(item, "type", "message") != "message":
                continue
            if getattr(item, "role", None) != "user":
                continue
            return (item.text_content or "").strip()
        return ""

    def _reply_for(self, chat_ctx: ChatContext) -> str:
        text = self._last_user_text(chat_ctx)
        low = text.lower()

        if not text:
            return "Hi, I'm Aura, your voice assistant. How can I help you today?"

        if any(w in low for w in ("hello", "hi ", "hey", "namaste", "good morning", "good evening")):
            return "Hello! I'm Aura. What can I do for you?"

        if any(w in low for w in ("your name", "who are you", "what are you")):
            return "I'm Aura, a realtime voice assistant running on LiveKit and Deepgram."

        if "how are you" in low:
            return "I'm doing great, thanks for asking. What would you like to talk about?"

        if "time" in low and any(w in low for w in ("what", "tell", "current")):
            return f"It's {datetime.now().strftime('%I:%M %p').lstrip('0')} right now."

        if "date" in low or "today" in low:
            return f"Today is {datetime.now().strftime('%A, %B %d, %Y')}."

        if "joke" in low:
            return random.choice(
                [
                    "Why did the developer go broke? Because he used up all his cache.",
                    "I told my computer I needed a break, and it said: no problem, I'll go to sleep.",
                    "There are only ten kinds of people: those who understand binary, and those who don't.",
                ]
            )

        if any(w in low for w in ("bye", "goodbye", "see you", "thank you", "thanks")):
            return "Anytime! Talk to you soon."

        if any(w in low for w in ("what can you do", "help me", "your features")):
            return (
                "I can listen to you and answer out loud in real time. "
                "Right now I'm running on my offline brain, so my answers are limited."
            )

        return (
            f"I heard you say: {text}. My language model is offline right now, "
            "so I can only echo you. Add a working API key to unlock full answers."
        )


# --------------------------------------------------------------------------- #
# Provider setup
# --------------------------------------------------------------------------- #


async def _llm_is_healthy(candidate: llm.LLM) -> tuple[bool, str]:
    """One cheap round trip so we fail loudly at startup, not mid-conversation."""
    probe_ctx = ChatContext.empty()
    probe_ctx.add_message(role="user", content="ping")
    try:
        async with candidate.chat(
            chat_ctx=probe_ctx,
            conn_options=APIConnectOptions(max_retry=0, retry_interval=0.5, timeout=15.0),
        ) as stream:
            async for _ in stream:
                break
        return True, ""
    except Exception as exc:  # noqa: BLE001 - any failure means "don't use it"
        return False, str(exc)


def _build_stt_tts(deepgram_key: str | None, openai_key: str | None):
    """Return (stt, tts, description) or (None, None, reason)."""
    if deepgram_key and deepgram:
        stt = deepgram.STT(
            api_key=deepgram_key,
            model="nova-3",
            language="en-US",
            interim_results=True,
            punctuate=True,
            smart_format=True,
            filler_words=False,
            endpointing_ms=300,
        )
        tts = deepgram.TTS(api_key=deepgram_key, model="aura-2-thalia-en")
        return stt, tts, "Deepgram nova-3 / aura-2"

    if openai_key and openai_plugin:
        stt = openai_plugin.STT(api_key=openai_key)
        tts = openai_plugin.TTS(api_key=openai_key)
        return stt, tts, "OpenAI whisper / tts-1"

    return None, None, "no usable STT/TTS credentials"


async def _build_llm(openai_key: str | None, gemini_key: str | None) -> tuple[llm.LLM, str]:
    """Pick the first cloud LLM that actually answers; fall back to offline.

    Google retires model aliases fairly often and free-tier quota is applied
    per model, so we probe a list rather than trusting one hardcoded name.
    Set GEMINI_MODEL / OPENAI_MODEL in .env to force a specific one.
    """
    offline = OfflineLLM()
    candidates: list[tuple[str, llm.LLM]] = []

    if gemini_key and google_plugin:
        forced = _clean_key("GEMINI_MODEL")
        models = ((forced, None),) if forced else GEMINI_MODELS
        for model, thinking in models:
            extra = {"thinking_config": thinking} if thinking else {}
            try:
                candidates.append(
                    (
                        f"Google {model}",
                        google_plugin.LLM(model=model, api_key=gemini_key, temperature=0.7, **extra),
                    )
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Could not construct Gemini %s: %s", model, exc)

    if openai_key and openai_plugin:
        model = _clean_key("OPENAI_MODEL") or "gpt-4o-mini"
        try:
            candidates.append((f"OpenAI {model}", openai_plugin.LLM(model=model, api_key=openai_key)))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not construct the OpenAI LLM: %s", exc)

    for name, candidate in candidates:
        logger.info("Checking LLM: %s ...", name)
        healthy, reason = await _llm_is_healthy(candidate)
        if healthy:
            logger.info("LLM ready: %s", name)
            # FallbackAdapter keeps the session alive if the provider dies later.
            return llm.FallbackAdapter([candidate, offline], attempt_timeout=20.0), name
        logger.error("LLM unavailable (%s): %s", name, reason.splitlines()[0][:200])

    logger.error(
        "No cloud LLM is reachable — Aura will answer from its offline brain. "
        "Set a working OPENAI_API_KEY or GEMINI_API_KEY in .env for full answers."
    )
    return offline, "offline (no cloud LLM reachable)"


# --------------------------------------------------------------------------- #
# Agent
# --------------------------------------------------------------------------- #


class AuraAgent(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)

    async def on_enter(self) -> None:
        self.session.generate_reply(
            instructions="Greet the user in one short sentence, say you are Aura, and ask how you can help."
        )


class UIBridge:
    """Publishes conversation events to the browser over the data channel."""

    def __init__(self, room: rtc.Room) -> None:
        self._room = room
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._task = asyncio.create_task(self._pump())

    def send(self, event: str, **data: Any) -> None:
        payload = json.dumps({"type": event, "ts": time.time(), **data}).encode("utf-8")
        self._queue.put_nowait(payload)

    async def _pump(self) -> None:
        while True:
            payload = await self._queue.get()
            try:
                await self._room.local_participant.publish_data(
                    payload, reliable=True, topic=DATA_TOPIC
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("Could not publish UI event: %s", exc)

    async def aclose(self) -> None:
        self._task.cancel()


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    logger.info("Connected to room %s", ctx.room.name)

    deepgram_key = _clean_key("DEEPGRAM_API_KEY")
    openai_key = _clean_key("OPENAI_API_KEY")
    gemini_key = _clean_key("GEMINI_API_KEY") or _clean_key("GOOGLE_API_KEY")

    stt, tts, voice_desc = _build_stt_tts(deepgram_key, openai_key)
    if stt is None or tts is None:
        logger.error("Cannot start: %s. Add DEEPGRAM_API_KEY to your .env file.", voice_desc)
        return
    logger.info("Speech pipeline: %s", voice_desc)

    if silero is None:
        logger.error("Cannot start: the Silero VAD plugin is not installed.")
        return

    try:
        vad = silero.VAD.load()
    except Exception as exc:  # noqa: BLE001
        logger.error("Cannot start: failed to load Silero VAD (%s).", exc)
        return

    chat_llm, llm_desc = await _build_llm(openai_key, gemini_key)

    session: AgentSession = AgentSession(
        vad=vad,
        stt=stt,
        llm=chat_llm,
        tts=tts,
        turn_handling=TurnHandlingOptions(
            turn_detection="vad",
            endpointing={"min_delay": 0.4, "max_delay": 2.5},
            preemptive_generation={"enabled": True},
            interruption={
                "enabled": True,
                # Require real speech before cutting Aura off, so room noise
                # and speaker bleed do not keep interrupting her.
                "min_words": 2,
                "min_duration": 0.4,
                "resume_false_interruption": True,
                "false_interruption_timeout": 1.5,
            },
        ),
    )

    ui = UIBridge(ctx.room)
    turn_started_at: float | None = None
    user_turn_id = 0

    @session.on("user_input_transcribed")
    def _on_user_transcript(event) -> None:
        nonlocal turn_started_at, user_turn_id
        text = (getattr(event, "transcript", "") or "").strip()
        if not text:
            return

        is_final = bool(getattr(event, "is_final", True))
        if turn_started_at is None:
            turn_started_at = time.monotonic()

        ui.send("user_message", id=f"u{user_turn_id}", text=text, final=is_final)

        if is_final:
            logger.info("You  > %s", text)
            user_turn_id += 1

    @session.on("conversation_item_added")
    def _on_item_added(event) -> None:
        item = event.item
        if getattr(item, "role", None) != "assistant":
            return
        text = (getattr(item, "text_content", None) or "").strip()
        if not text:
            return
        logger.info("Aura > %s", text)
        ui.send("agent_message", id=getattr(item, "id", None) or f"a{time.time()}", text=text)

    @session.on("agent_state_changed")
    def _on_state(event) -> None:
        nonlocal turn_started_at
        state = str(event.new_state)
        payload: dict[str, Any] = {"state": state}

        if state == "speaking" and turn_started_at is not None:
            payload["latency_ms"] = round((time.monotonic() - turn_started_at) * 1000)
            turn_started_at = None

        ui.send("agent_state", **payload)

    @session.on("error")
    def _on_error(event) -> None:
        message = str(getattr(event, "error", event))
        logger.error("Session error: %s", message)
        if "429" in message or "quota" in message.lower():
            friendly = "The language model API is out of quota. Check your keys in .env."
        elif "401" in message or "403" in message:
            friendly = "An API key was rejected. Check your keys in .env."
        else:
            friendly = f"Something went wrong: {message[:160]}"
        ui.send("error", text=friendly)

    await session.start(
        agent=AuraAgent(),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            text_output=room_io.TextOutputOptions(sync_transcription=True),
        ),
    )

    ui.send("ready", stt=voice_desc, llm=llm_desc)
    logger.info("Aura is live — LLM: %s", llm_desc)

    # Late joiners (a page refresh) need the pipeline banner too.
    @ctx.room.on("participant_connected")
    def _on_participant(participant: rtc.RemoteParticipant) -> None:
        logger.info("Participant joined: %s", participant.identity)
        ui.send("ready", stt=voice_desc, llm=llm_desc)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
