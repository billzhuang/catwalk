"""Runnable voice bot: the pipecat audio pipeline with flue in the LLM slot.

    browser mic ⇄ WebRTC ⇄  transport.input()
                            → SileroVAD (turn-taking)
                            → MaiTranscribeSTT   (MAI-Transcribe-1.5, east-us-1)
                            → FlueLLMProcessor    (flue harness → gpt-5.4 + weather tool)
                            → MaiVoiceTTS         (MAI-Voice-2, east-us-2)
                            → transport.output()  ⇄ browser speaker

Run:  python run_bot.py           # serves WebRTC + prebuilt client on http://localhost:7860
Needs the flue agent service running (npm run dev in ../flue-agent) and
~/env/aifoundry.sh credentials.
"""
from __future__ import annotations

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.runner.run import main
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.transports.base_transport import TransportParams

from bot.flue_llm import FlueLLMProcessor
from bot.mai_stt import MaiTranscribeSTT
from bot.mai_tts import MaiVoiceTTS, SAMPLE_RATE as TTS_SAMPLE_RATE

STT_SAMPLE_RATE = 16000

# In pipecat 1.5 VAD is a pipeline stage (VADProcessor), not a transport param.
transport_params = {
    "webrtc": lambda: TransportParams(
        audio_in_enabled=True,
        audio_out_enabled=True,
    ),
}


def build_pipeline(transport, conversation_id: str = "voice") -> Pipeline:
    """Assemble VAD → STT → flue → TTS between the transport's audio ends. Testable.

    VADProcessor emits the speaking-boundary frames that the segmented MAI-Transcribe
    STT uses to know when an utterance is complete.
    """
    vad = VADProcessor(vad_analyzer=SileroVADAnalyzer())
    stt = MaiTranscribeSTT()
    llm = FlueLLMProcessor(conversation_id=conversation_id)
    tts = MaiVoiceTTS()
    return Pipeline([transport.input(), vad, stt, llm, tts, transport.output()])


async def bot(runner_args: RunnerArguments):
    transport = await create_transport(runner_args, transport_params)
    conversation_id = getattr(runner_args, "session_id", None) or "voice"
    pipeline = build_pipeline(transport, conversation_id)
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=STT_SAMPLE_RATE,
            audio_out_sample_rate=TTS_SAMPLE_RATE,
            enable_metrics=False,
        ),
    )
    logger.info("Voice bot ready: MAI-Transcribe-1.5 → flue/gpt-5.4 → MAI-Voice-2")
    await PipelineRunner().run(task)


if __name__ == "__main__":
    main()
