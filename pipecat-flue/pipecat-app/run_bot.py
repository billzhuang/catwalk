"""Runnable voice bot: the pipecat audio pipeline with flue in the LLM slot.

    browser mic ⇄ WebRTC ⇄  transport.input()
                            → SileroVAD (turn-taking)
                            → MaiTranscribeSTT   (MAI-Transcribe-1.5, east-us-1)
                            → FlueLLMProcessor    (flue harness → gpt-5.4 + weather tool)
                            → MaiVoiceTTS         (MAI-Voice-2, east-us-2)
                            → transport.output()  ⇄ browser speaker

Run:  python run_bot.py           # serves WebRTC + the custom /app/ client on http://localhost:7860
                                  # ('/' redirects to /app/; the prebuilt client is at /client/)
Needs the flue agent service running (npm run dev in ../flue-agent) and
~/env/aifoundry.sh credentials.
"""
from __future__ import annotations

import re
import time
from pathlib import Path

import httpx
from fastapi import Query
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import ErrorFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.runner.run import app, main
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.transports.base_transport import TransportParams
from pipecat.turns.user_turn_processor import UserTurnProcessor

from bot.animations import render
from bot.flue_llm import FlueLLMProcessor, resolve_flue_base_url
from bot.mai_stt import MaiTranscribeSTT
from bot.mai_tts import MaiVoiceTTS, SAMPLE_RATE as TTS_SAMPLE_RATE

STT_SAMPLE_RATE = 16000

# Spoken fallback for a non-fatal pipeline error (e.g. an Azure REST hiccup in MaiTranscribeSTT
# or MaiVoiceTTS — see bot/mai_stt.py, bot/mai_tts.py). Without this the student just hears
# silence: STT swallowing the turn means FlueLLMProcessor never even sees it, and TTS failing
# means a reply was produced but never spoken. Silence is otherwise the only feedback channel in
# this hands-free voice UI, so it's indistinguishable from "you weren't heard" or "nothing to
# say." FlueLLMProcessor already apologizes out loud on its own failures (bot/flue_llm.py); this
# gives STT/TTS the same fallback.
PIPELINE_ERROR_APOLOGY = "Sorry, I didn't catch that. Could you say that again?"

# The apology TTSSpeakFrame above is itself spoken through MaiVoiceTTS, so a persistent TTS
# outage (expired key, sustained 429, network down) makes the apology fail non-fatally too —
# which without a guard would retrigger this same handler and queue another apology, forever,
# hammering the already-failing service. Suppressing repeats within this window breaks that
# loop while still allowing a fresh apology for a later, unrelated failure.
APOLOGY_COOLDOWN_S = 5.0


def build_apology_handler(task: PipelineTask):
    """Build an on_pipeline_error handler that speaks PIPELINE_ERROR_APOLOGY for non-fatal
    errors, suppressing repeats within APOLOGY_COOLDOWN_S. A standalone function (rather than
    inline in bot()) so it can be unit-tested directly instead of only through bot()'s full
    transport/pipeline bootstrap."""
    last_apology_at: float | None = None

    async def _on_pipeline_error(_task, frame: ErrorFrame):
        # Fatal errors already cancel the whole pipeline (pipecat's own worker.py); only the
        # non-fatal ones need a fallback here, since that's the case nothing downstream
        # otherwise handles for STT/TTS. TTSSpeakFrame (not a plain TextFrame) is the mechanism
        # already used for out-of-band speech (see pipecat's own BusTTSSpeakMessage handling in
        # pipeline/worker.py): it gets its own turn context, so it doesn't need bracketing
        # LLMFullResponseStart/EndFrames the way a reply routed through FlueLLMProcessor does.
        # append_to_context=False since this apology never went through flue, which owns the
        # actual conversation memory.
        nonlocal last_apology_at
        if frame.fatal:
            return
        now = time.monotonic()
        if last_apology_at is not None and now - last_apology_at < APOLOGY_COOLDOWN_S:
            return  # see APOLOGY_COOLDOWN_S: breaks the apology-retriggers-itself loop
        last_apology_at = now
        await task.queue_frame(TTSSpeakFrame(PIPELINE_ERROR_APOLOGY, append_to_context=False))

    return _on_pipeline_error


# Every route below is dynamic (animation state, on-the-fly SVGs, the client shell) and must
# never be served from a stale cache.
NO_STORE_HEADERS = {"Cache-Control": "no-store"}

# --- Custom browser client + animation delivery, on the runner's FastAPI app. -------------
# We serve our own client at /app/ (the prebuilt /client/ is a fixed UI). Animation delivery is
# DECOUPLED from the WebRTC audio connection: the client tags its connection with a clientId
# (offer request_data) that becomes the flue conversation id, then polls GET /animation/{cid}
# (proxied to flue) on its own HTTP channel — so a flaky/renegotiating audio data channel can
# never swallow the cue. The student can also pace an on-the-fly animation's steps by voice
# (flue's control_math_animation tool); the poll response's `revision` field is how the client
# notices either a new topic or a step change. Routes are registered before main() so they
# coexist with the runner's.
CLIENT_DIR = Path(__file__).parent / "client"
# FLUE_BASE_URL lets this process follow flue-agent's own PORT/FLUE_PORT override (see
# model-config.ts's resolvePort) instead of being stuck at the hardcoded default address.
FLUE_BASE = resolve_flue_base_url()
# One shared client for the (once-per-second-per-browser) animation poll proxy. Unlike the
# per-pipeline-stage clients (FlueLLMProcessor/MaiTranscribeSTT/MaiVoiceTTS, closed via
# OwnedHttpClientCleanupMixin at pipeline teardown), this one is a bare module-level global tied
# to the FastAPI app's own lifetime, so it's closed on the app's shutdown event instead.
_FLUE_CLIENT_TIMEOUT = 5


def _new_flue_client() -> httpx.AsyncClient:
    """Construct `_flue_client` with its fixed timeout — shared by the module-level initial
    client and _open_flue_client's replacement, so the two constructor calls can't silently
    drift to different timeouts."""
    return httpx.AsyncClient(timeout=_FLUE_CLIENT_TIMEOUT)


_flue_client = _new_flue_client()


async def _open_flue_client():
    # A closed httpx.AsyncClient can't be reopened, so if the app's ASGI lifespan ever runs a
    # second startup in the same interpreter (e.g. a test harness, or an embedded-server reload)
    # after _close_flue_client has closed the previous instance, animation_poll's broad except
    # would otherwise silently degrade to {"topic": null} instead of proxying. Recreate it here
    # so startup/shutdown stay symmetric. Close whatever the previous client was first — a
    # second startup without an intervening shutdown would otherwise drop a still-open client
    # and leak its connection pool for the process's lifetime.
    global _flue_client
    if not _flue_client.is_closed:
        await _flue_client.aclose()
    _flue_client = _new_flue_client()


async def _close_flue_client():
    await _flue_client.aclose()


app.router.on_startup.append(_open_flue_client)
app.router.on_shutdown.append(_close_flue_client)


def _not_found(message: str) -> Response:
    """Plain-text 404 with the module's no-store headers — shared by animation_svg's unknown-
    topic case and app_client's missing-index case, which otherwise duplicate this same shape."""
    return Response(message, status_code=404, media_type="text/plain", headers=NO_STORE_HEADERS)


def _no_animation(status_code: int = 200) -> JSONResponse:
    """The `{"topic": null}` no-store response animation_poll returns for both a rejected cid
    (400) and a flue-proxy failure (200) — shared so the two branches can't drift on shape."""
    return JSONResponse({"topic": None}, status_code=status_code, headers=NO_STORE_HEADERS)


@app.get("/", include_in_schema=False)
async def root_to_app():
    """Land on OUR client, not the prebuilt one. Registered before main(), so it wins over the
    runner's default `/` -> /client/ redirect (the prebuilt client ignores our animation cue)."""
    return RedirectResponse(url="/app/")


@app.get("/animation/{cid}")
async def animation_poll(cid: str):
    """Decoupled animation delivery: the client polls this for its conversation's current
    animation state (proxied from flue), including a `revision` that increments on every new
    topic or voice-paced step change (see flue-agent/src/app.ts) — the client tracks the last
    revision it saw itself rather than relying on the server to clear anything. Independent of
    the WebRTC data channel.

    `cid` is f-string-interpolated straight into the proxied request URL below, the same
    confused-deputy shape resolve_conversation_id's clientId guards against (see
    _SAFE_CONVERSATION_ID) — an unvalidated cid could steer this call at flue-agent's internal
    routes instead of its own /animation/{cid}. Rejected outright rather than sanitized."""
    if not _SAFE_CONVERSATION_ID.fullmatch(cid):
        return _no_animation(status_code=400)
    try:
        r = await _flue_client.get(f"{FLUE_BASE}/animation/{cid}")
        return JSONResponse(r.json(), headers=NO_STORE_HEADERS)
    except Exception as e:  # noqa: BLE001
        logger.debug(f"animation poll proxy failed (non-fatal): {e}")
        return _no_animation()


@app.get("/animation-svg/{topic}")
async def animation_svg(
    topic: str,
    title: str | None = Query(default=None),
    steps: list[str] | None = Query(default=None),
    step: int = 0,
):
    """Render a math animation SVG on demand. Hand-built topics come from the
    bot.animations.SCENES whitelist and ignore `step` (they loop continuously, no discrete
    steps); any other topic renders on the fly from title/steps, with `step` selecting which
    one is current (see bot.animations.render/build_generic_svg)."""
    try:
        svg = render(topic, title=title, steps=steps, current_step=step)
    except KeyError:
        return _not_found("unknown animation topic")
    return Response(svg, media_type="image/svg+xml", headers=NO_STORE_HEADERS)


@app.get("/app", include_in_schema=False)
@app.get("/app/", include_in_schema=False)
async def app_client():
    """Serve our single-file client with no-store, so a redeploy is never masked by a stale
    cached copy (the whole client is self-contained — no separate asset files to mount)."""
    index = CLIENT_DIR / "index.html"
    if not index.is_file():
        return _not_found("client not found")
    return FileResponse(index, media_type="text/html", headers=NO_STORE_HEADERS)

# In pipecat 1.5 VAD is a pipeline stage (VADProcessor), not a transport param.
transport_params = {
    "webrtc": lambda: TransportParams(
        audio_in_enabled=True,
        audio_out_enabled=True,
    ),
}


def build_pipeline(transport, conversation_id: str = "voice") -> Pipeline:
    """Assemble VAD → STT → turns → flue → TTS between the transport's audio ends.

    - VADProcessor emits the speaking-boundary frames the segmented MAI-Transcribe STT
      uses to bound each utterance.
    - UserTurnProcessor turns "user started speaking" into a pipeline interruption
      (barge-in). We replaced pipecat's LLM context aggregator with flue, so this is
      what re-enables interruptions. It also drives continuous, hands-free turn-taking
      (no click between turns). Interruption is VAD-driven here; a transcription-based
      min-words gate isn't effective because MAI-Transcribe is segmented (no interim
      words). To make barge-in less/more sensitive, tune VADProcessor's
      speech_activity_period.
    """
    vad = VADProcessor(vad_analyzer=SileroVADAnalyzer())
    stt = MaiTranscribeSTT()
    turns = UserTurnProcessor()
    llm = FlueLLMProcessor(base_url=FLUE_BASE, conversation_id=conversation_id)
    tts = MaiVoiceTTS()
    return Pipeline([transport.input(), vad, stt, turns, llm, tts, transport.output()])


# clientId becomes conversation_id, which FlueLLMProcessor f-string-interpolates straight into
# its internal request URL (f"{base_url}/agents/{agent}/{conversation_id}", plus "/abort"). Unlike
# a URL path segment, an offer body field isn't shielded from "/" or ".." by any router constraint
# — an unrestricted clientId of "../../az/v1/chat/completions" makes httpx's own URL normalization
# resolve every subsequent turn's POST to flue-agent's internal Azure proxy route instead of
# /agents/weather/:id, a confused-deputy SSRF that forwards attacker-influenced text to Azure
# OpenAI under the service's real api-key. Legitimate clientIds are a crypto.randomUUID() or the
# client's "c-<timestamp>-<random>" fallback (see client/index.html), both well under 64 chars.
# animation_poll's `cid` path param is f-string-interpolated into a proxied request URL the same
# way, so it reuses this same guard rather than a second hand-rolled charset check. The charset
# alone doesn't bound length, so an oversized clientId would still become an oversized request
# line on every turn's proxied call and a same-sized key retained in flue-agent's per-conversation
# state maps (bounded by entry count, not key size) until eviction catches up — cap it too.
_MAX_CONVERSATION_ID_LENGTH = 128
_SAFE_CONVERSATION_ID = re.compile(rf"^[A-Za-z0-9_-]{{1,{_MAX_CONVERSATION_ID_LENGTH}}}$")


def resolve_conversation_id(runner_args: RunnerArguments) -> str:
    """Prefer the clientId the browser tagged its offer with (request_data) so it can poll
    GET /animation/<clientId> for this conversation; fall back to the server session id,
    then a fixed default. A clientId outside the safe path-segment charset is rejected outright
    (see _SAFE_CONVERSATION_ID) rather than sanitized, so it can never select anything but a
    same-level conversation id."""
    body = getattr(runner_args, "body", None) or {}
    client_id = body.get("clientId") if isinstance(body, dict) else None
    if isinstance(client_id, str) and _SAFE_CONVERSATION_ID.fullmatch(client_id):
        return client_id
    return getattr(runner_args, "session_id", None) or "voice"


async def bot(runner_args: RunnerArguments):
    transport = await create_transport(runner_args, transport_params)
    conversation_id = resolve_conversation_id(runner_args)
    pipeline = build_pipeline(transport, conversation_id)
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=STT_SAMPLE_RATE,
            audio_out_sample_rate=TTS_SAMPLE_RATE,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )

    task.add_event_handler("on_pipeline_error", build_apology_handler(task))

    logger.info("Voice bot ready: MAI-Transcribe-1.5 → flue/gpt-5.4 → MAI-Voice-2")
    await PipelineRunner().run(task)


if __name__ == "__main__":
    main()
