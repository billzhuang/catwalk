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

from pathlib import Path

import httpx
from fastapi import Query
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
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
from bot.flue_llm import FlueLLMProcessor
from bot.mai_stt import MaiTranscribeSTT
from bot.mai_tts import MaiVoiceTTS, SAMPLE_RATE as TTS_SAMPLE_RATE

STT_SAMPLE_RATE = 16000

# --- Custom browser client + animation delivery, on the runner's FastAPI app. -------------
# We serve our own client at /app/ (the prebuilt /client/ is a fixed UI). Animation delivery is
# DECOUPLED from the WebRTC audio connection: the client tags its connection with a clientId
# (offer request_data) that becomes the flue conversation id, then polls GET /animation/{cid}
# (proxied to flue) on its own HTTP channel — so a flaky/renegotiating audio data channel can
# never swallow the cue. Routes are registered before main() so they coexist with the runner's.
CLIENT_DIR = Path(__file__).parent / "client"
FLUE_BASE = "http://127.0.0.1:3583"
# One shared client for the (once-per-second-per-browser) animation poll proxy.
_flue_client = httpx.AsyncClient(timeout=5)


@app.get("/", include_in_schema=False)
async def root_to_app():
    """Land on OUR client, not the prebuilt one. Registered before main(), so it wins over the
    runner's default `/` -> /client/ redirect (the prebuilt client ignores our animation cue)."""
    return RedirectResponse(url="/app/")


@app.get("/animation/{cid}")
async def animation_poll(cid: str):
    """Decoupled animation delivery: the client polls this for its conversation's pending
    animation (proxied read-and-clear from flue). Independent of the WebRTC data channel."""
    try:
        r = await _flue_client.get(f"{FLUE_BASE}/animation/{cid}")
        return JSONResponse(r.json(), headers={"Cache-Control": "no-store"})
    except Exception as e:  # noqa: BLE001
        logger.debug(f"animation poll proxy failed (non-fatal): {e}")
        return JSONResponse({"topic": None}, headers={"Cache-Control": "no-store"})


@app.get("/animation-svg/{topic}")
async def animation_svg(
    topic: str,
    title: str | None = Query(default=None),
    steps: list[str] | None = Query(default=None),
):
    """Render a math animation SVG on demand. Hand-built topics come from the
    bot.animations.SCENES whitelist; any other topic renders on the fly from
    title/steps (see bot.animations.render/build_generic_svg)."""
    try:
        svg = render(topic, title=title, steps=steps)
    except KeyError:
        return Response("unknown animation topic", status_code=404, media_type="text/plain")
    return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "no-store"})


@app.get("/app", include_in_schema=False)
@app.get("/app/", include_in_schema=False)
async def app_client():
    """Serve our single-file client with no-store, so a redeploy is never masked by a stale
    cached copy (the whole client is self-contained — no separate asset files to mount)."""
    index = CLIENT_DIR / "index.html"
    if not index.is_file():  # pragma: no cover
        return Response("client not found", status_code=404, media_type="text/plain")
    return FileResponse(index, media_type="text/html", headers={"Cache-Control": "no-store"})

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
    llm = FlueLLMProcessor(conversation_id=conversation_id)
    tts = MaiVoiceTTS()
    return Pipeline([transport.input(), vad, stt, turns, llm, tts, transport.output()])


async def bot(runner_args: RunnerArguments):
    transport = await create_transport(runner_args, transport_params)
    # Prefer the clientId the browser tagged its offer with (request_data) so it can poll
    # GET /animation/<clientId> for this conversation; fall back to the server session id.
    body = getattr(runner_args, "body", None) or {}
    conversation_id = (body.get("clientId") if isinstance(body, dict) else None) \
        or getattr(runner_args, "session_id", None) or "voice"
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
    logger.info("Voice bot ready: MAI-Transcribe-1.5 → flue/gpt-5.4 → MAI-Voice-2")
    await PipelineRunner().run(task)


if __name__ == "__main__":
    main()
