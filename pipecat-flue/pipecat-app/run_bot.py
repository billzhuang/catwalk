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
from pipecat.turns.user_turn_processor import UserTurnProcessor

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
    conversation_id = getattr(runner_args, "session_id", None) or "voice"
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
