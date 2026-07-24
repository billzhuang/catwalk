"""FlueLLMProcessor — the flue harness sitting in the LLM slot of the pipeline.

STT emits a TranscriptionFrame; this processor forwards the user's text to the
flue agent service (POST /agents/weather/:id?wait=result), gets the reply, and
pushes it downstream as a TextFrame that the TTS service turns into speech.

Barge-in: pipecat's _start_interruption() cancels this processor's in-flight
process task, which cancels the awaited httpx request automatically. That stops
OUR side, but flue's `?wait=result` turn keeps settling server-side after the
caller disconnects, so on interruption we also POST /agents/weather/:id/abort to
stop the server-side turn (and save tokens). The same is true when we give up on
our own (ask() times out, the connection drops, flue returns a non-2xx) rather
than because the user interrupted, so process_frame's except block aborts too.

/abort targets the conversation id, not a specific turn (it has no per-turn
token to key off), so a detached abort left over from a prior turn could still
be in flight when the *next* turn's request goes out and land at flue after
that new turn has already started — cancelling the wrong one. We track every
scheduled-but-unresolved abort in `_pending_aborts` and await all of them
before starting a new turn, so any stale abort is always resolved (success or
its own 10s giveup) before the next request is ever sent. A set rather than a
single slot: _start_interruption() can in principle fire again (e.g. two
barge-ins landing back-to-back) while an earlier scheduled abort is still
running — a single slot would silently overwrite that earlier task's
reference, orphaning it so it's never waited for.
"""
from __future__ import annotations

import asyncio
import os

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

from .http_client_cleanup import OwnedHttpClientCleanupMixin

# Metrics-only label; keep in sync with flue-agent's FLUE_MODEL (see
# flue-agent/src/model-config.ts) since flue owns the actual model selection.
# Mirrors model-config.ts's resolveModel(): trim and treat a blank value as
# unset, since os.environ.get(key, default) only substitutes default when the
# key is absent, not when it's present-but-empty (e.g. `export FLUE_MODEL=`).
MODEL_LABEL = os.environ.get("FLUE_MODEL", "").strip() or "azure/gpt-5.4"


def _usage_int(usage: dict, key: str, default: int = 0) -> int:
    """flue's usage dict may omit a field or send it as JSON null; either way
    treat it as `default` rather than raising in `int()`. Checking `is None`
    (rather than truthiness) matters because an explicit 0 is a valid value
    that must not be overridden by a non-zero `default` (e.g. totalTokens)."""
    val = usage.get(key)
    return default if val is None else int(val)


class FlueLLMProcessor(OwnedHttpClientCleanupMixin, FrameProcessor):
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
        self._pending_aborts: set[asyncio.Task] = set()  # see module docstring
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
        return (result.get("text") or "").strip(), (result.get("usage") or {})

    async def _emit_usage(self, usage: dict):
        if not usage:
            return
        inp = _usage_int(usage, "input")
        out = _usage_int(usage, "output")
        tokens = LLMTokenUsage(
            prompt_tokens=inp,
            completion_tokens=out,
            total_tokens=_usage_int(usage, "totalTokens", inp + out),
            cache_read_input_tokens=_usage_int(usage, "cacheRead"),
            cache_creation_input_tokens=_usage_int(usage, "cacheWrite"),
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

    def _schedule_abort(self):
        """Fire _abort() as a detached task (so it survives this turn's own
        cancellation/cleanup) and track it so a later turn can wait for it.
        Added to the set rather than replacing a single slot, so scheduling a
        second abort before an earlier one resolves can't drop the earlier
        task's reference (see module docstring)."""
        self._pending_aborts.add(self.create_task(self._abort()))

    async def _await_pending_abort(self):
        """Resolve every abort left over from previous turns before this turn's
        request goes out, so a stale abort can never land at flue after a new
        turn has already started there (see module docstring).

        Shielded per-task: this wait itself runs inside the next turn's process
        task, so a second barge-in arriving before a stale abort resolves cancels
        that process task too. Awaiting a task unshielded would propagate that
        cancellation straight into it (asyncio cancels whatever a cancelled task
        is currently awaiting), silently killing the abort mid-flight. asyncio.shield
        keeps each abort task running detached through that cancellation instead;
        the `finally` only discards a task once it has actually finished, so if
        this wait gets cancelled partway through the set, the remaining (and any
        still-unfinished) tasks stay tracked for the next turn to wait for."""
        for task in list(self._pending_aborts):
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                logger.debug(f"pending flue abort task failed (non-fatal): {e}")
            finally:
                if task.done():
                    self._pending_aborts.discard(task)

    async def _start_interruption(self):
        # Fire the server-side abort BEFORE super() cancels our process task
        # (which cancels the in-flight httpx request).
        if self._in_flight:
            self._schedule_abort()
        await super()._start_interruption()

    async def _handle_transcription(self, frame: TranscriptionFrame):
        text = (frame.text or "").strip()
        if not text:
            return
        logger.debug(f"flue <- {text!r}")
        await self._await_pending_abort()
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
            # ask() failing client-side (timeout, connection error, non-2xx) doesn't
            # mean flue's server-side turn stopped too — same reasoning as the
            # barge-in abort above, just reached via a different giving-up path.
            # Detached (not awaited) so the apology isn't delayed by this best-effort call;
            # _await_pending_abort() resolves it before the *next* turn instead.
            self._schedule_abort()
        finally:
            self._in_flight = False
        logger.debug(f"flue -> {reply!r}")
        await self.push_frame(TextFrame(reply))
        await self._emit_usage(usage)
        await self.push_frame(LLMFullResponseEndFrame())

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            await self._handle_transcription(frame)
        else:
            # Forward everything else (Start/End/audio/control frames) untouched.
            await self.push_frame(frame, direction)
