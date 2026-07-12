"""Shared pytest helpers for pipecat-app tests.

`flue_up`/`requires_flue` were independently redefined, byte-for-byte identical, in
test_interruption.py, test_flue_pipeline.py, and test_e2e_audio.py.

`Capture` was also independently redefined in all three files, each tapping a different
subset of frame types into its own fields; unified here so a test just reads whichever
fields it cares about and leaves the rest empty.
"""
import httpx
import pytest
from pipecat.frames.frames import Frame, MetricsFrame, TextFrame, TranscriptionFrame, TTSAudioRawFrame
from pipecat.metrics.metrics import LLMUsageMetricsData
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

FLUE_BASE = "http://127.0.0.1:3583"


def flue_up() -> bool:
    try:
        return httpx.get(f"{FLUE_BASE}/health", timeout=3).status_code == 200
    except Exception:
        return False


requires_flue = pytest.mark.skipif(not flue_up(), reason="flue agent service not running on :3583")


class Capture(FrameProcessor):
    """Test double that records frames of interest and passes everything through unmodified."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.texts: list[str] = []
        self.transcripts: list[str] = []
        self.prompt_tokens = 0
        self.tts_bytes = bytearray()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            self.transcripts.append(frame.text)
        elif isinstance(frame, TextFrame):
            self.texts.append(frame.text)
        elif isinstance(frame, TTSAudioRawFrame):
            self.tts_bytes.extend(frame.audio)
        elif isinstance(frame, MetricsFrame):
            for d in frame.data:
                if isinstance(d, LLMUsageMetricsData):
                    self.prompt_tokens += d.value.prompt_tokens
        await self.push_frame(frame, direction)
