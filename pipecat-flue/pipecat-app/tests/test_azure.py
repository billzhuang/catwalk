"""Characterization tests for bot/azure.py's section-aware credential loader.

Pins current parsing/selection/override behavior before and after extracting the
duplicated api_key/speech_endpoint fallback logic (see mai_stt.py / mai_tts.py) into
resolve_speech_credentials(). No prior test coverage existed for this module.

Also pins new_speech_client()/NoMetricsMixin, extracted from mai_tts.py and
mai_stt.py's identical `httpx.AsyncClient(timeout=60)` construction and
`can_generate_metrics` override (neither was asserted by either service's own
tests before this extraction).
"""
import httpx
import pytest

from bot.azure import (
    Block,
    NoMetricsMixin,
    load_blocks,
    log_and_format_error,
    new_speech_client,
    resolve_speech_credentials,
    stt_block,
    tts_block,
)
from tests.conftest import write_aifoundry_env

AIFOUNDRY_SH = """
# east-us-2
apikey=key-us2
openai_endpoint=https://res-us2.openai.azure.com/openai/v1

# east-us-1
export apikey=key-us1
export openai_endpoint=https://res-us1.openai.azure.com/openai/v1/
"""


def _write_env(tmp_path, contents=AIFOUNDRY_SH):
    return write_aifoundry_env(tmp_path, contents)


def test_block_speech_endpoint_derives_cognitiveservices_host():
    b = Block("east-us-2", "key", "https://my-res.openai.azure.com/openai/v1")
    assert b.speech_endpoint == "https://my-res.cognitiveservices.azure.com"


def test_block_speech_endpoint_empty_when_no_host_match():
    b = Block("weird", "key", "not-a-url")
    assert b.speech_endpoint == "https://.cognitiveservices.azure.com"


def test_load_blocks_is_section_aware_and_strips_export_and_quotes(tmp_path):
    path = _write_env(tmp_path)
    blocks = load_blocks(path)
    assert [b.label for b in blocks] == ["east-us-2", "east-us-1"]
    assert blocks[0].apikey == "key-us2"
    assert blocks[0].endpoint == "https://res-us2.openai.azure.com/openai/v1"
    # trailing slash stripped, `export` prefix and quoting handled
    assert blocks[1].apikey == "key-us1"
    assert blocks[1].endpoint == "https://res-us1.openai.azure.com/openai/v1"


def test_load_blocks_skips_incomplete_sections(tmp_path):
    path = _write_env(tmp_path, "# only-key\napikey=solo\n")
    assert load_blocks(path) == []


def test_load_blocks_ignores_stray_label_line(tmp_path):
    # A stray `label=` line inside a section must not clobber the header-derived
    # label — mirrors config.ts's loadBlocks, which guards against this explicitly.
    path = _write_env(
        tmp_path,
        "# east-us-2\napikey=k\nopenai_endpoint=https://res.openai.azure.com/openai/v1\nlabel=hijacked\n",
    )
    blocks = load_blocks(path)
    assert len(blocks) == 1
    assert blocks[0].label == "east-us-2"


def test_tts_block_picks_east_us_2(tmp_path, monkeypatch):
    monkeypatch.setenv("AIFOUNDRY_ENV", _write_env(tmp_path))
    block = tts_block()
    assert block.label == "east-us-2"
    assert block.apikey == "key-us2"


def test_tts_block_matches_on_us_2_substring_alone(tmp_path, monkeypatch):
    # A block labeled anything containing "us-2" must match via that one needle.
    # (A prior version also checked "esat-us-2" — a typo for "east-us-2" that,
    # being a superstring of "us-2", could never match anything "us-2" didn't
    # already match — so it was unreachable and removed.)
    monkeypatch.setenv(
        "AIFOUNDRY_ENV",
        _write_env(
            tmp_path,
            "\n# west-us-2\napikey=key-w2\nopenai_endpoint=https://res-w2.openai.azure.com/openai/v1\n",
        ),
    )
    block = tts_block()
    assert block.label == "west-us-2"


def test_stt_block_picks_east_us_1(tmp_path, monkeypatch):
    monkeypatch.setenv("AIFOUNDRY_ENV", _write_env(tmp_path))
    block = stt_block()
    assert block.label == "east-us-1"
    assert block.apikey == "key-us1"


def test_tts_and_stt_block_fall_back_by_index_when_no_needle_matches(tmp_path, monkeypatch):
    # Neither block's label/endpoint contains "us-1" or "us-2", so both tts_block()
    # (needles=["us-2"], fallback=0) and stt_block() (needles=["us-1"], fallback=-1)
    # must fall through to their index fallback rather than a substring match.
    monkeypatch.setenv(
        "AIFOUNDRY_ENV",
        _write_env(
            tmp_path,
            "\n# region-a\napikey=key-a\nopenai_endpoint=https://res-a.openai.azure.com/openai/v1\n"
            "\n# region-b\napikey=key-b\nopenai_endpoint=https://res-b.openai.azure.com/openai/v1\n",
        ),
    )
    # fallback=0 -> first block.
    assert tts_block().label == "region-a"
    # fallback=-1 -> Python's negative indexing picks the *last* block (unlike the TS
    # twin, pickBlock, where plain `[]` bracket access on -1 is undefined and falls
    # through to `?? blocks[0]` instead — the two "parity" implementations diverge here).
    assert stt_block().label == "region-b"


def test_tts_block_raises_when_no_credential_blocks_found(tmp_path, monkeypatch):
    monkeypatch.setenv("AIFOUNDRY_ENV", _write_env(tmp_path, "# only-key\napikey=solo\n"))
    with pytest.raises(RuntimeError, match="No Azure credential blocks found"):
        tts_block()


def test_resolve_speech_credentials_prefers_explicit_overrides():
    block = Block("label", "block-key", "https://res.openai.azure.com/openai/v1")
    api_key, endpoint = resolve_speech_credentials(block, "explicit-key", "https://explicit.example.com")
    assert (api_key, endpoint) == ("explicit-key", "https://explicit.example.com")


def test_resolve_speech_credentials_falls_back_to_block():
    block = Block("label", "block-key", "https://res.openai.azure.com/openai/v1")
    api_key, endpoint = resolve_speech_credentials(block, None, None)
    assert api_key == "block-key"
    assert endpoint == block.speech_endpoint


def test_log_and_format_error_uses_frame_label_and_preserves_exception_text():
    # Pins mai_stt.py's pre-refactor inline shape: logger.error(f"MAI-Transcribe
    # failed: {e}") + ErrorFrame(f"transcription failed: {e}") — the log and frame
    # labels differ on purpose, so both must be threaded through independently.
    msg = log_and_format_error("MAI-Transcribe", "transcription", ValueError("boom"))
    assert msg == "transcription failed: boom"


def test_log_and_format_error_mai_voice_shape():
    # Pins mai_tts.py's pre-refactor inline shape: logger.error(f"MAI-Voice-2
    # failed: {e}") + ErrorFrame(f"tts failed: {e}").
    msg = log_and_format_error("MAI-Voice-2", "tts", RuntimeError("network down"))
    assert msg == "tts failed: network down"


def test_new_speech_client_defaults_to_60s_timeout():
    client = new_speech_client()
    assert isinstance(client, httpx.AsyncClient)
    assert client.timeout.connect == 60


def test_new_speech_client_honors_explicit_timeout():
    client = new_speech_client(timeout=5)
    assert client.timeout.connect == 5


def test_no_metrics_mixin_reports_no_metrics_support():
    assert NoMetricsMixin().can_generate_metrics() is False
