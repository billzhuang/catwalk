#!/usr/bin/env python3
"""
Voice-chain test server for Azure AI Foundry.

Chain:  mic audio --STT--> text --gpt-5.4(+weather tool)--> reply --TTS--> audio

- Chat runs on gpt-5.4 (confirmed deployed on this resource).
- STT/TTS try the MAI models (MAI-Transcribe-1.5 / MAI-Voice-2). If those
  deployments don't exist yet, the endpoints return {"ok": false, ...} and the
  browser falls back to the Web Speech API so the demo still works today.
- Live weather comes from Open-Meteo (free, no key) via a gpt-5.4 tool call.

The Azure key never leaves the server; the browser only talks to this proxy.

Run:  python3 server.py           # http://127.0.0.1:8000
Env:  PORT, CHAT_MODEL, STT_MODEL, TTS_MODEL, TTS_VOICE, AIFOUNDRY_ENV
"""
import json
import os
import re
import ssl
import struct
import sys
import urllib.request
import urllib.parse
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.expanduser(os.environ.get("AIFOUNDRY_ENV", "~/env/aifoundry.sh"))

CHAT_MODEL = os.environ.get("CHAT_MODEL", "gpt-5.4")
STT_MODEL = os.environ.get("STT_MODEL", "MAI-Transcribe-1.5")
TTS_MODEL = os.environ.get("TTS_MODEL", "MAI-Voice-2")
# MAI-Voice-2 voice, format "<locale>-<Name>:MAI-Voice-2". English options:
# en-US-Jasper / en-US-Ethan / en-US-Grant (M), en-US-Olivia / en-US-Iris / en-US-Harper (F).
TTS_VOICE = os.environ.get("TTS_VOICE", "en-US-Jasper:MAI-Voice-2")
PORT = int(os.environ.get("PORT", "8000"))

SYSTEM_PROMPT = (
    "You are a friendly voice assistant in a spoken conversation. "
    "Keep replies short and natural — one to three sentences, no markdown, no lists, "
    "no emoji — because your text will be read aloud. "
    "You can look up live weather with the get_weather tool for any place the user mentions. "
    "When you have weather data, mention the temperature and conditions conversationally."
)


def load_sections(path):
    """Parse the env file into ordered credential blocks keyed by `# comment` headers.

    The file holds two resources under the same var names (apikey / openapi_endpoint),
    grouped by `# east-us-2` / `# east-us-1` comments, so a flat parse would let the
    later block clobber the earlier one. We keep them separate instead.
    """
    blocks, cur = [], None
    try:
        with open(path) as fh:
            for line in fh:
                s = line.strip()
                if s.startswith("#"):
                    cur = {"label": s.lstrip("# ").strip()}
                    blocks.append(cur)
                    continue
                if not s or "=" not in s:
                    continue
                s = re.sub(r"^export\s+", "", s)
                k, v = s.split("=", 1)
                if cur is None:
                    cur = {"label": "(default)"}
                    blocks.append(cur)
                cur[k.strip().lower()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        sys.exit(f"Config file not found: {path}")
    return [b for b in blocks if "apikey" in b and "openapi_endpoint" in b]


def _pick(blocks, *needles, default_idx=0):
    """First block whose label or endpoint contains any needle, else default_idx."""
    for b in blocks:
        hay = (b["label"] + " " + b["openapi_endpoint"]).lower()
        if any(n in hay for n in needles):
            return b
    return blocks[default_idx] if blocks else None


def _speech_host(openai_ep):
    """https://<res>.openai.azure.com/openai/v1 -> https://<res>.cognitiveservices.azure.com

    MAI-Voice / MAI-Transcribe use the Azure Speech (Cognitive Services) API on this
    sibling host of the same resource, not the OpenAI-compatible route.
    """
    m = re.match(r"https?://([^./]+)\.", openai_ep)
    return f"https://{(m.group(1) if m else '')}.cognitiveservices.azure.com"


_blocks = load_sections(ENV_FILE)
if not _blocks:
    sys.exit(f"No apikey / openapi_endpoint found in {ENV_FILE}")

# Chat (gpt-5.4) + TTS (MAI-Voice-2) live on the east-us-2 resource.
_chat_block = _pick(_blocks, "us-2", "esat-us-2", default_idx=0)
# STT (MAI-Transcribe-1.5, LLM Speech) needs a supported region: east-us-1.
_stt_block = _pick(_blocks, "us-1", default_idx=len(_blocks) - 1)

API_KEY = _chat_block["apikey"]
ENDPOINT = _chat_block["openapi_endpoint"].rstrip("/")
SPEECH_ENDPOINT = os.environ.get("SPEECH_ENDPOINT", _speech_host(ENDPOINT)).rstrip("/")

STT_KEY = _stt_block["apikey"]
STT_ENDPOINT = os.environ.get("STT_SPEECH_ENDPOINT",
                              _speech_host(_stt_block["openapi_endpoint"])).rstrip("/")
STT_MAI_MODEL = os.environ.get("STT_MAI_MODEL", "mai-transcribe-1.5")

_ssl_ctx = ssl.create_default_context()


def _xml_escape(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("'", "&apos;"))


def _silent_wav(seconds=0.4, rate=16000):
    """Build a tiny mono 16-bit PCM WAV of silence (for probing STT)."""
    n = int(seconds * rate)
    data = b"\x00\x00" * n
    hdr = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
    hdr += struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    hdr += b"data" + struct.pack("<I", len(data))
    return hdr + data


# ---------------------------------------------------------------------------
# Azure calls
# ---------------------------------------------------------------------------
def _http_error_json(e):
    """Best-effort JSON parse of an HTTPError body, falling back to a truncated message."""
    body = e.read().decode(errors="replace")
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"error": {"message": body[:500]}}


def azure_json(path, payload, method="POST"):
    """POST JSON to the Azure endpoint, return (status, parsed_json_or_text)."""
    url = f"{ENDPOINT}/{path.lstrip('/')}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"api-key": API_KEY, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, context=_ssl_ctx, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, _http_error_json(e)
    except Exception as e:  # noqa: BLE001
        return 0, {"error": {"message": str(e)}}


def azure_bytes(path, payload):
    """POST JSON, expect binary (audio) back. Returns (status, bytes_or_errjson, content_type)."""
    url = f"{ENDPOINT}/{path.lstrip('/')}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"api-key": API_KEY, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, context=_ssl_ctx, timeout=60) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "audio/mpeg")
    except urllib.error.HTTPError as e:
        return e.code, _http_error_json(e), "application/json"
    except Exception as e:  # noqa: BLE001
        return 0, {"error": {"message": str(e)}}, "application/json"


def azure_multipart(path, fields, file_field, filename, file_bytes, file_ctype):
    """POST multipart/form-data (for /audio/transcriptions)."""
    url = f"{ENDPOINT}/{path.lstrip('/')}"
    boundary = "----voicechain7MA4YWxkTrZu0gW"
    parts = []
    for k, v in fields.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        )
    parts.append(
        (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; "
         f"filename=\"{filename}\"\r\nContent-Type: {file_ctype}\r\n\r\n").encode()
    )
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"api-key": API_KEY,
                 "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, context=_ssl_ctx, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, _http_error_json(e)
    except Exception as e:  # noqa: BLE001
        return 0, {"error": {"message": str(e)}}


# ---------------------------------------------------------------------------
# Azure Speech: MAI-Voice-2 TTS + standard fast-transcription STT
# ---------------------------------------------------------------------------
def speech_tts(text, voice):
    """MAI-Voice-2 text-to-speech via the Speech REST API. Returns (status, bytes)."""
    ssml = ("<speak version='1.0' xml:lang='en-US'>"
            f"<voice name='{voice}'>{_xml_escape(text)}</voice></speak>").encode()
    req = urllib.request.Request(
        f"{SPEECH_ENDPOINT}/tts/cognitiveservices/v1", data=ssml, method="POST",
        headers={
            "Ocp-Apim-Subscription-Key": API_KEY,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
            "User-Agent": "voicechain",
        })
    try:
        with urllib.request.urlopen(req, context=_ssl_ctx, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # noqa: BLE001
        return 0, str(e).encode()


def speech_stt(audio_bytes, ctype, use_mai=True):
    """Azure fast transcription. Returns (status, text_or_None, err_or_None).

    Uses MAI-Transcribe-1.5 (LLM Speech) via the east-us-1 resource by default;
    set use_mai=False for the standard model on the same endpoint.
    """
    url = f"{STT_ENDPOINT}/speechtotext/transcriptions:transcribe?api-version=2025-10-15"
    boundary = "----voicechainSTT7MA4YWxkTrZu"
    defn = {"locales": ["en-US"]}
    if use_mai:
        defn["enhancedMode"] = {"enabled": True, "model": STT_MAI_MODEL,
                                "transcribeStyle": "verbatim"}
    definition = json.dumps(defn)
    parts = [
        (f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; "
         f"filename=\"a\"\r\nContent-Type: {ctype or 'application/octet-stream'}\r\n\r\n").encode(),
        audio_bytes,
        (f"\r\n--{boundary}\r\nContent-Disposition: form-data; "
         f"name=\"definition\"\r\n\r\n{definition}\r\n").encode(),
        f"--{boundary}--\r\n".encode(),
    ]
    req = urllib.request.Request(
        url, data=b"".join(parts), method="POST",
        headers={"Ocp-Apim-Subscription-Key": STT_KEY,
                 "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, context=_ssl_ctx, timeout=60) as r:
            d = json.loads(r.read().decode())
            phrases = d.get("combinedPhrases")
            text = phrases[0].get("text", "") if phrases else d.get("text", "")
            return r.status, text, None
    except urllib.error.HTTPError as e:
        return e.code, None, e.read().decode(errors="replace")[:300]
    except Exception as e:  # noqa: BLE001
        return 0, None, str(e)


# ---------------------------------------------------------------------------
# Weather tool (Open-Meteo, free / no key)
# ---------------------------------------------------------------------------
WMO = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "depositing rime fog", 51: "light drizzle", 53: "moderate drizzle",
    55: "dense drizzle", 61: "slight rain", 63: "moderate rain", 65: "heavy rain",
    66: "light freezing rain", 67: "heavy freezing rain", 71: "slight snow",
    73: "moderate snow", 75: "heavy snow", 77: "snow grains", 80: "slight rain showers",
    81: "moderate rain showers", 82: "violent rain showers", 85: "slight snow showers",
    86: "heavy snow showers", 95: "thunderstorm", 96: "thunderstorm with slight hail",
    99: "thunderstorm with heavy hail",
}

WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current, real weather for a city or place name.",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "City or place, e.g. 'Tokyo' or 'Paris, France'"}
            },
            "required": ["city"],
        },
    },
}


def _get(url):
    with urllib.request.urlopen(url, context=_ssl_ctx, timeout=20) as r:
        return json.loads(r.read().decode())


def get_weather(city):
    try:
        geo = _get("https://geocoding-api.open-meteo.com/v1/search?"
                   + urllib.parse.urlencode({"name": city, "count": 1}))
        results = geo.get("results")
        if not results:
            return {"error": f"Could not find a place called '{city}'."}
        g = results[0]
        lat, lon = g["latitude"], g["longitude"]
        label = ", ".join(x for x in [g.get("name"), g.get("admin1"), g.get("country")] if x)
        w = _get("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode({
            "latitude": lat, "longitude": lon,
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,"
                       "wind_speed_10m,weather_code",
        }))
        c = w.get("current", {})
        code = c.get("weather_code")
        return {
            "location": label,
            "temperature_c": c.get("temperature_2m"),
            "feels_like_c": c.get("apparent_temperature"),
            "humidity_pct": c.get("relative_humidity_2m"),
            "wind_kmh": c.get("wind_speed_10m"),
            "conditions": WMO.get(code, f"code {code}"),
        }
    except Exception as e:  # noqa: BLE001
        return {"error": f"Weather lookup failed: {e}"}


# ---------------------------------------------------------------------------
# Chat with tool loop
# ---------------------------------------------------------------------------
def run_chat(user_messages):
    messages = [{"role": "system", "content": SYSTEM_PROMPT}] + user_messages
    for _ in range(4):  # allow a couple of tool round-trips
        status, resp = azure_json("chat/completions", {
            "model": CHAT_MODEL,
            "messages": messages,
            "tools": [WEATHER_TOOL],
            "tool_choice": "auto",
        })
        if status != 200:
            return status, None, resp.get("error", {}).get("message", "chat error")
        msg = resp["choices"][0]["message"]
        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            return 200, msg.get("content", ""), None
        # Execute tool calls, feed results back
        messages.append(msg)
        for tc in tool_calls:
            args = {}
            try:
                args = json.loads(tc["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                pass
            result = get_weather(args.get("city", "")) if tc["function"]["name"] == "get_weather" else {"error": "unknown tool"}
            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": json.dumps(result),
            })
    return 200, "Sorry, I got stuck looking that up.", None


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "voicechain/1.0"

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n else b""

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % args))

    # -- routes --
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html"):
            try:
                with open(os.path.join(HERE, "index.html"), "rb") as fh:
                    return self._send(200, fh.read(), "text/html; charset=utf-8")
            except FileNotFoundError:
                return self._send(404, {"error": "index.html not found"})
        if path == "/api/health":
            return self._send(200, self._health())
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/chat":
            return self._chat()
        if path == "/api/tts":
            return self._tts()
        if path == "/api/stt":
            return self._stt()
        return self._send(404, {"error": "not found"})

    # -- health: report what actually works on this resource --
    def _health(self):
        chat_ok = azure_json("chat/completions", {
            "model": CHAT_MODEL, "max_completion_tokens": 16,
            "messages": [{"role": "user", "content": "hi"}],
        })[0] == 200
        # MAI-Voice-2 via the Speech endpoint (east-us-2).
        tts_ok = speech_tts("hi", TTS_VOICE)[0] == 200
        # MAI-Transcribe-1.5 via east-us-1. Probe with a short silent clip:
        # 200 => works; 400 unless the message says the model isn't supported.
        s, _, err = speech_stt(_silent_wav(0.6), "audio/wav")
        stt_ok = s == 200 or (s == 400 and "not supported" not in (err or "").lower())
        return {
            "chat": {"model": CHAT_MODEL, "deployed": chat_ok},
            "tts": {"model": TTS_MODEL, "voice": TTS_VOICE, "deployed": tts_ok,
                    "via": "azure-speech"},
            "stt": {"model": STT_MODEL, "deployed": stt_ok, "via": STT_MAI_MODEL},
            "endpoint": ENDPOINT,
            "speech_endpoint": SPEECH_ENDPOINT,
            "stt_endpoint": STT_ENDPOINT,
        }

    def _chat(self):
        try:
            data = json.loads(self._read_body() or "{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "invalid JSON"})
        msgs = data.get("messages")
        if not isinstance(msgs, list) or not msgs:
            return self._send(400, {"error": "messages[] required"})
        status, text, err = run_chat(msgs)
        if err:
            return self._send(502, {"ok": False, "error": err})
        return self._send(200, {"ok": True, "reply": text, "model": CHAT_MODEL})

    def _tts(self):
        try:
            data = json.loads(self._read_body() or "{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "invalid JSON"})
        text = (data.get("text") or "").strip()
        if not text:
            return self._send(400, {"error": "text required"})
        status, body = speech_tts(text, data.get("voice", TTS_VOICE))
        if status == 200:
            return self._send(200, body, "audio/mpeg")
        detail = body.decode(errors="replace")[:300] if isinstance(body, bytes) else str(body)
        return self._send(200, {"ok": False, "model": TTS_MODEL, "status": status, "detail": detail})

    def _stt(self):
        # MAI-Transcribe-1.5 (east-us-1); falls back to standard model on error.
        ctype = self.headers.get("Content-Type", "")
        audio = self._read_body()
        if not audio:
            return self._send(400, {"error": "audio body required"})
        status, text, err = speech_stt(audio, ctype, use_mai=True)
        model = STT_MAI_MODEL
        if status != 200:
            status, text, err = speech_stt(audio, ctype, use_mai=False)
            model = "azure-fast-transcription"
        if status == 200:
            return self._send(200, {"ok": True, "text": text, "model": model})
        return self._send(200, {"ok": False, "status": status, "detail": err})


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Voice-chain server on http://127.0.0.1:{PORT}")
    print(f"  chat: {CHAT_MODEL} @ {ENDPOINT}")
    print(f"  tts : {TTS_MODEL} ({TTS_VOICE}) @ {SPEECH_ENDPOINT}")
    print(f"  stt : {STT_MODEL} ({STT_MAI_MODEL}) @ {STT_ENDPOINT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
