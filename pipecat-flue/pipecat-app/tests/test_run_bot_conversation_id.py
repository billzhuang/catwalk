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
