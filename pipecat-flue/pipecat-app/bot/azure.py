"""Section-aware loader for ~/env/aifoundry.sh (never committed).

Two Azure resources share the same variable names under `# east-us-2` /
`# east-us-1` comment headers, so we parse by section rather than sourcing.
MAI-Voice-2 (TTS) lives on east-us-2; MAI-Transcribe-1.5 (STT) needs east-us-1
(the LLM-Speech region).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from xml.sax.saxutils import escape

import httpx
from loguru import logger


@dataclass
class Block:
    label: str
    apikey: str
    endpoint: str  # OpenAI-compatible root, e.g. https://<res>.openai.azure.com/openai/v1

    @property
    def speech_endpoint(self) -> str:
        """https://<res>.openai.azure.com/... -> https://<res>.cognitiveservices.azure.com"""
        m = re.match(r"https?://([^./]+)\.", self.endpoint)
        res = m.group(1) if m else ""
        return f"https://{res}.cognitiveservices.azure.com"


def load_blocks(path: str | None = None) -> list[Block]:
    p = path or os.environ.get("AIFOUNDRY_ENV", "~/env/aifoundry.sh")
    file = Path(p).expanduser()
    blocks: list[dict] = []
    cur: dict | None = None
    for raw in file.read_text().splitlines():
        s = raw.strip()
        if s.startswith("#"):
            cur = {"label": s.lstrip("# ").strip()}
            blocks.append(cur)
            continue
        if not s or "=" not in s:
            continue
        s = re.sub(r"^export\s+", "", s)
        k, _, v = s.partition("=")
        if cur is None:
            cur = {"label": "(default)"}
            blocks.append(cur)
        cur[k.strip().lower()] = v.strip().strip('"').strip("'")
    return [
        Block(b["label"], b["apikey"], b["openai_endpoint"].rstrip("/"))
        for b in blocks
        if b.get("apikey") and b.get("openai_endpoint")
    ]


def _pick(needles: list[str], fallback: int) -> Block:
    blocks = load_blocks()
    for b in blocks:
        hay = f"{b.label} {b.endpoint}".lower()
        if any(n in hay for n in needles):
            return b
    if not blocks:
        raise RuntimeError("No Azure credential blocks found in aifoundry.sh")
    return blocks[fallback if -len(blocks) <= fallback < len(blocks) else 0]


def tts_block() -> Block:
    """MAI-Voice-2 (TTS) — east-us-2."""
    return _pick(["us-2"], 0)


def stt_block() -> Block:
    """MAI-Transcribe-1.5 (STT, LLM Speech) — east-us-1."""
    return _pick(["us-1"], -1)


def resolve_speech_credentials(
    block: Block, api_key: str | None, speech_endpoint: str | None
) -> tuple[str, str]:
    """Explicit constructor overrides win; otherwise fall back to the resolved block."""
    return api_key or block.apikey, speech_endpoint or block.speech_endpoint


async def synthesize_ssml(
    client: httpx.AsyncClient,
    endpoint: str,
    api_key: str,
    voice: str,
    text: str,
    output_format: str,
    *,
    user_agent: str = "pipecat-voice-chain",
) -> bytes:
    """POST SSML to a MAI-Voice-2 TTS REST endpoint, return raw PCM."""
    ssml = f"<speak version='1.0' xml:lang='en-US'><voice name='{voice}'>{escape(text)}</voice></speak>"
    r = await client.post(
        f"{endpoint.rstrip('/')}/tts/cognitiveservices/v1",
        headers={
            "Ocp-Apim-Subscription-Key": api_key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": output_format,
            "User-Agent": user_agent,
        },
        content=ssml.encode(),
    )
    r.raise_for_status()
    return r.content


def log_and_format_error(log_label: str, frame_label: str, e: Exception) -> str:
    """Log a REST call failure under `log_label`, return the `frame_label`-prefixed
    message an ErrorFrame should carry downstream (the two labels differ: the log is
    named after the Azure service, the frame after the pipeline stage it broke)."""
    logger.opt(exception=e).error(f"{log_label} failed")
    return f"{frame_label} failed: {e}"
