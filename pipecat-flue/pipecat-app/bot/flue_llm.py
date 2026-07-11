"""FlueLLMProcessor — the flue harness sitting in the LLM slot of the pipeline.

STT emits a TranscriptionFrame; this processor forwards the user's text to the
flue agent service (POST /agents/weather/:id?wait=result), gets the reply, and
pushes it downstream as a TextFrame that the TTS service turns into speech.

The react/tool loop, conversation memory, and model call all live in flue — the
pipeline only moves text across the seam.
"""
from __future__ import annotations

import httpx
from loguru import logger
from pipecat.frames.frames import (
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    TextFrame,
    TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


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

    async def ask(self, message: str) -> str:
        """Call the flue agent and return its reply text. Isolated for testing."""
        r = await self._client.post(self._url, params={"wait": "result"}, json={"message": message})
        r.raise_for_status()
        data = r.json()
        return (data.get("result") or {}).get("text", "").strip()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            text = (frame.text or "").strip()
            if not text:
                return
            logger.debug(f"flue <- {text!r}")
            await self.push_frame(LLMFullResponseStartFrame())
            try:
                reply = await self.ask(text)
            except Exception as e:  # noqa: BLE001
                logger.error(f"flue call failed: {e}")
                reply = "Sorry, I had trouble thinking just now. Could you say that again?"
            logger.debug(f"flue -> {reply!r}")
            await self.push_frame(TextFrame(reply))
            await self.push_frame(LLMFullResponseEndFrame())
        else:
            # Forward everything else (Start/End/audio/control frames) untouched.
            await self.push_frame(frame, direction)
