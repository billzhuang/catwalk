"""Unit: resolve_conversation_id's clientId/session_id/default fallback chain. No network,
no pipeline — calls the function directly with a duck-typed runner_args stand-in."""
from types import SimpleNamespace

from run_bot import resolve_conversation_id


def test_prefers_clientid_from_dict_body_over_session_id():
    args = SimpleNamespace(body={"clientId": "browser-tagged-id"}, session_id="server-session")
    assert resolve_conversation_id(args) == "browser-tagged-id"


def test_falls_back_to_session_id_when_body_has_no_clientid():
    args = SimpleNamespace(body={}, session_id="server-session")
    assert resolve_conversation_id(args) == "server-session"


def test_falls_back_to_voice_when_nothing_is_set():
    args = SimpleNamespace(body=None, session_id=None)
    assert resolve_conversation_id(args) == "voice"


def test_ignores_non_dict_body():
    args = SimpleNamespace(body="not-a-dict", session_id="server-session")
    assert resolve_conversation_id(args) == "server-session"


def test_missing_body_attribute_falls_back_to_session_id():
    args = SimpleNamespace(session_id="server-session")
    assert resolve_conversation_id(args) == "server-session"


def test_rejects_path_traversal_clientid_instead_of_interpolating_it_verbatim():
    """A clientId ends up f-string-interpolated straight into FlueLLMProcessor's internal
    request URL (f"{base_url}/agents/{agent}/{conversation_id}"). Confirmed against the actual
    httpx URL-construction path: httpx.Client().build_request('POST',
    'http://x/agents/weather/../../az/v1/chat/completions') normalizes to
    'http://x/az/v1/chat/completions' *before the request is sent* — so an unvalidated clientId
    of "../../az/v1/chat/completions" would silently redirect every turn's POST to flue-agent's
    internal Azure proxy route (which injects the real api-key) instead of /agents/weather/:id.
    Must fall back to session_id, not pass the traversal payload through."""
    args = SimpleNamespace(body={"clientId": "../../az/v1/chat/completions"}, session_id="server-session")
    assert resolve_conversation_id(args) == "server-session"


def test_rejects_clientid_containing_a_slash():
    args = SimpleNamespace(body={"clientId": "a/b"}, session_id="server-session")
    assert resolve_conversation_id(args) == "server-session"


def test_rejects_clientid_with_a_trailing_newline():
    """Python's re `$` (unlike `\\Z`) also matches just before a single trailing "\n", so a
    charset check anchored with `$` under re.match lets "abc123\n" through as "safe" even though
    it isn't pure [A-Za-z0-9_-]+. That string then gets f-string-interpolated into
    FlueLLMProcessor's request URL (f"{base_url}/agents/{agent}/{conversation_id}"), and httpx
    rejects embedded control characters in a URL (httpx.InvalidURL: "Invalid non-printable ASCII
    character in URL"), breaking every turn of that call. Must fall back to session_id instead."""
    args = SimpleNamespace(body={"clientId": "abc123\n"}, session_id="server-session")
    assert resolve_conversation_id(args) == "server-session"


def test_accepts_a_real_client_uuid():
    args = SimpleNamespace(body={"clientId": "3fa85f64-5717-4562-b3fc-2c963f66afa6"}, session_id="server-session")
    assert resolve_conversation_id(args) == "3fa85f64-5717-4562-b3fc-2c963f66afa6"


def test_accepts_the_client_fallback_id_shape():
    """See client/index.html's non-crypto fallback: "c-" + Date.now() + "-" + random int."""
    args = SimpleNamespace(body={"clientId": "c-1732000000000-123456"}, session_id="server-session")
    assert resolve_conversation_id(args) == "c-1732000000000-123456"
