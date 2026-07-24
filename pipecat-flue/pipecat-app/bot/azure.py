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


def _strip_quotes(v: str) -> str:
    """Strip at most one quote char from each end (independently, regardless of whether
    they match) — mirrors flue-agent's parseKeyValue (paths.ts), which parses this same
    ~/env/aifoundry.sh file. `str.strip('"')`/`.strip("'")` instead strip *every* matching
    char off each end, so a doubly-quoted value like `""key""` came out as `key` here but
    `"key"` on the TS side — the two "parity" parsers disagreed on the same input."""
    if v and v[0] in "\"'":
        v = v[1:]
    if v and v[-1] in "\"'":
        v = v[:-1]
    return v


@dataclass
class _Header:
    label: str
    fresh_paragraph: bool  # opened a new paragraph: start of file, or right after a blank line


@dataclass
class _Pair:
    key: str
    value: str


def _scan_env_lines(text: str) -> list[_Header | _Pair]:
    """Classify a `~/env/*.sh` file's text into headers and key=value pairs, mirroring
    flue-agent's parseEnvLines (paths.ts) so the two "parity" parsers scan the same file the
    same way. Blank lines and non-`=` lines are dropped. Pure, independent of block-grouping."""
    out: list[_Header | _Pair] = []
    preceded_by_blank = True
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            preceded_by_blank = True
            continue
        if s.startswith("#"):
            out.append(_Header(s.lstrip("# ").strip(), preceded_by_blank))
            preceded_by_blank = False
            continue
        preceded_by_blank = False
        if "=" not in s:
            continue
        s = re.sub(r"^export\s+", "", s)
        k, _, v = s.partition("=")
        out.append(_Pair(k.strip().lower(), _strip_quotes(v.strip())))
    return out


def load_blocks(path: str | None = None) -> list[Block]:
    p = path or os.environ.get("AIFOUNDRY_ENV", "~/env/aifoundry.sh")
    text = Path(p).expanduser().read_text()
    blocks: list[dict] = []
    cur: dict | None = None
    for line in _scan_env_lines(text):
        if isinstance(line, _Header):
            # A header starts a new section if it opens a new paragraph (the common
            # aifoundry.sh convention) OR the current block already has both required keys, so
            # a header immediately following a complete section, with no blank line, still
            # starts a new one. Otherwise it's an inline note (e.g. a rotation date) inside the
            # section still being gathered, and must not split it into two incomplete blocks.
            #
            # But if `cur` is itself still an empty, *unconfirmed* stub (no keys gathered yet,
            # and it was only opened because the previous section had just completed — not
            # because this header opened a fresh paragraph), this header can't be "inline inside"
            # a section that never really started, and pushing a second, sibling stub would bury
            # the prior header's label as an orphan while this one's real section only inherits
            # whatever keys follow. Relabel the still-empty stub in place instead, so a run of
            # blank-line-less headers collapses onto whichever one immediately precedes keys. A
            # *confirmed* stub — one that did open a fresh paragraph, the strong "this is a real
            # section" signal — is left alone: a header can't demote it, only add to it as an
            # inline note (e.g. `# east-us-2` directly followed by `# rotate quarterly`, with
            # neither key yet, must keep the `east-us-2` label). `_confirmed` is a private marker
            # key, dropped from the output below since only `label`/`apikey`/`openai_endpoint` are read.
            if cur is not None and not cur.get("_confirmed") and not cur.get("apikey") and not cur.get("openai_endpoint"):
                cur["label"] = line.label
            elif line.fresh_paragraph or cur is None or (cur.get("apikey") and cur.get("openai_endpoint")):
                is_new_section = line.fresh_paragraph or cur is None
                cur = {"label": line.label, "_confirmed": is_new_section}
                blocks.append(cur)
            continue
        if cur is None:
            cur = {"label": "(default)"}
            blocks.append(cur)
        if line.key == "label":
            continue  # don't let a stray `label=` line clobber the header's label
        cur[line.key] = line.value
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
    return blocks[fallback]


def tts_block() -> Block:
    """MAI-Voice-2 (TTS) — east-us-2."""
    return _pick(["east-us-2"], 0)


def stt_block() -> Block:
    """MAI-Transcribe-1.5 (STT, LLM Speech) — east-us-1."""
    return _pick(["east-us-1"], -1)


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


def new_speech_client(timeout: float = 60) -> httpx.AsyncClient:
    """Shared httpx client construction for the two MAI speech services."""
    return httpx.AsyncClient(timeout=timeout)


class NoMetricsMixin:
    """Both MAI speech services report no internal metrics support to pipecat."""

    def can_generate_metrics(self) -> bool:
        return False
