"""FlueLLMProcessor — the flue harness sitting in the LLM slot of the pipeline.

STT emits a TranscriptionFrame; this processor forwards the user's text to the
flue agent service (POST /agents/weather/:id?wait=result), gets the reply, and
pushes it downstream as a TextFrame that the TTS service turns into speech.

Barge-in: pipecat's _start_interruption() cancels this processor's in-flight
process task, which cancels the awaited httpx request automatically. That stops
OUR side, but flue's `?wait=result` turn keeps settling server-side after the
caller disconnects, so on interruption we also POST /agents/weather/:id/abort to
stop the server-side turn (and save tokens).
"""
from __future__ import annotations

import httpx
from loguru import logger
from pipecat.frames.frames import (
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    MetricsFrame,
    TextFrame,
    TranscriptionFrame,
)
from pipecat.metrics.metrics import LLMTokenUsage, LLMUsageMetricsData
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

MODEL_LABEL = "azure/gpt-5.4"


class FlueLLMProcessor(FrameProcessor):
    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:3583",
        agent: str = "weather",
        conversation_id: str = "voice",
        timeout_s: float = 90.0,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._url = f"{base_url}/agents/{agent}/{conversation_id}"
        self._client = httpx.AsyncClient(timeout=timeout_s)
        self._in_flight = False
        self.abort_count = 0  # observable for tests

    async def ask(self, message: str) -> tuple[str, dict]:
        """Call the flue agent. Returns (reply_text, usage). Isolated for testing.

        flue reports token usage per turn as {input, output, cacheRead, cacheWrite,
        totalTokens}; we surface it as a pipecat metric so the client's Token Usage
        panel populates (our custom processor isn't a pipecat LLM service, so nothing
        emits those metrics otherwise).
        """
        r = await self._client.post(self._url, params={"wait": "result"}, json={"message": message})
        r.raise_for_status()
        result = r.json().get("result") or {}
        return result.get("text", "").strip(), (result.get("usage") or {})

    async def _emit_usage(self, usage: dict):
        if not usage:
            return
        inp = int(usage.get("input", 0) or 0)
        out = int(usage.get("output", 0) or 0)
        tokens = LLMTokenUsage(
            prompt_tokens=inp,
            completion_tokens=out,
            total_tokens=int(usage.get("totalTokens", inp + out) or (inp + out)),
            cache_read_input_tokens=int(usage.get("cacheRead", 0) or 0),
            cache_creation_input_tokens=int(usage.get("cacheWrite", 0) or 0),
        )
        await self.push_frame(
            MetricsFrame(data=[LLMUsageMetricsData(processor=self.name, model=MODEL_LABEL, value=tokens)])
        )

    async def _abort(self):
        """Best-effort: stop flue's server-side turn after a barge-in."""
        self.abort_count += 1
        try:
            await self._client.post(f"{self._url}/abort", timeout=10)
            logger.debug("flue turn aborted (barge-in)")
        except Exception as e:  # noqa: BLE001
            logger.debug(f"flue abort failed (non-fatal): {e}")

    async def _start_interruption(self):
        # Fire the server-side abort BEFORE super() cancels our process task
        # (which cancels the in-flight httpx request). Runs as a detached task so
        # it survives the process-task cancellation.
        if self._in_flight:
            self.create_task(self._abort())
        await super()._start_interruption()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            text = (frame.text or "").strip()
            if not text:
                return
            logger.debug(f"flue <- {text!r}")
            await self.push_frame(LLMFullResponseStartFrame())
            self._in_flight = True
            usage: dict = {}
            try:
                # CancelledError (from barge-in) is a BaseException, so it is NOT
                # caught here — it propagates, and no reply is pushed downstream.
                reply, usage = await self.ask(text)
            except Exception as e:  # noqa: BLE001
                logger.error(f"flue call failed: {e}")
                reply = "Sorry, I had trouble thinking just now. Could you say that again?"
            finally:
                self._in_flight = False
            logger.debug(f"flue -> {reply!r}")
            await self.push_frame(TextFrame(reply))
            await self._emit_usage(usage)
            await self.push_frame(LLMFullResponseEndFrame())
        else:
            # Forward everything else (Start/End/audio/control frames) untouched.
            await self.push_frame(frame, direction)
