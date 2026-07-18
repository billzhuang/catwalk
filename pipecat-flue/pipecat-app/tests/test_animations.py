"""Every animation scene renders to well-formed, looping SVG, and render() is
a whitelist. No network, no services."""
import hashlib
import re
from pathlib import Path
from xml.dom.minidom import parseString

import pytest

from bot.animations import (
    MAX_GENERIC_STEP,
    MAX_GENERIC_STEPS,
    MAX_GENERIC_TITLE,
    SCENES,
    build_derivative_svg,
    build_generic_svg,
    build_pythagoras_svg,
    build_sine_svg,
    build_vectors_svg,
    list_topics,
    render,
)


@pytest.mark.parametrize("topic", ["sine", "pythagoras", "derivative", "vectors"])
def test_scene_is_wellformed_animated_svg(topic):
    svg = render(topic)
    assert svg.startswith("<svg")
    assert svg.rstrip().endswith("</svg>")
    parseString(svg)  # raises if not well-formed XML
    assert "<animate" in svg  # matches <animate and <animateTransform
    assert 'repeatCount="indefinite"' in svg


def test_registry_matches_topics():
    assert set(SCENES) == {"sine", "pythagoras", "derivative", "vectors"}
    assert list_topics() == ["derivative", "pythagoras", "sine", "vectors"]


def test_topics_match_flue_agent_and_client():
    """The four hand-built topics are declared independently in three places — SCENES here,
    ANIMATION_TOPICS in flue-agent/src/animation.ts, and the topic chips in
    pipecat-app/client/index.html — with nothing enforcing they stay in sync. Pins that all
    three agree, so a topic added/renamed/removed in one place without the others fails here
    instead of silently drifting (e.g. a client chip for a topic bot/animations.py can't
    actually render as a hand-built scene, or vice versa)."""
    pipecat_flue_root = Path(__file__).resolve().parents[2]

    animation_ts = (pipecat_flue_root / "flue-agent" / "src" / "animation.ts").read_text(
        encoding="utf-8"
    )
    ts_list = re.search(r"ANIMATION_TOPICS = \[(.*?)\]", animation_ts, re.DOTALL)
    assert ts_list, "couldn't find ANIMATION_TOPICS in animation.ts"
    ts_topics = sorted(re.findall(r"'([^']+)'", ts_list.group(1)))

    index_html = (pipecat_flue_root / "pipecat-app" / "client" / "index.html").read_text(
        encoding="utf-8"
    )
    html_topics = sorted(set(re.findall(r'data-topic="([^"]+)"', index_html)))

    assert ts_topics == list_topics()
    assert html_topics == list_topics()


def test_generic_limits_match_flue_agent_schema():
    """The generic-scene length caps here (MAX_GENERIC_STEP/STEPS/TITLE) are declared
    independently from flue-agent's show_math_animation tool schema, with only a comment
    ("mirrors this" / "matching flue-agent's schema cap") claiming they agree — nothing
    enforces it. Pins the two in sync so a schema change on one side without the other fails
    here instead of silently letting the model send text this SVG renderer clips or that the
    schema rejects even though the SVG could render it fine."""
    pipecat_flue_root = Path(__file__).resolve().parents[2]
    animation_ts = (pipecat_flue_root / "flue-agent" / "src" / "animation.ts").read_text(
        encoding="utf-8"
    )

    max_steps = re.search(r"MAX_STEPS = (\d+)", animation_ts)
    max_step_length = re.search(r"MAX_STEP_LENGTH = (\d+)", animation_ts)
    title_max_length = re.search(
        r"title: v\.optional\(\s*v\.pipe\(v\.string\(\), v\.trim\(\), v\.minLength\(1\), "
        r"v\.maxLength\((\d+)\)",
        animation_ts,
    )
    assert max_steps and max_step_length and title_max_length, (
        "couldn't find MAX_STEPS/MAX_STEP_LENGTH/title maxLength in animation.ts"
    )

    assert int(max_steps.group(1)) == MAX_GENERIC_STEPS
    assert int(max_step_length.group(1)) == MAX_GENERIC_STEP
    assert int(title_max_length.group(1)) == MAX_GENERIC_TITLE


def test_render_is_deterministic():
    assert render("sine") == render("sine")
    assert render("vectors") == render("vectors")


# Characterization test pinning exact byte-for-byte SVG output (default params) so an
# internal refactor of the <animate>/<animateTransform> tag-building code can be verified
# to change nothing observable.
SCENE_SHA256 = {
    "sine": "4ea8f3e0d5a0883b23edd75860bd0aa0c23fcd9763ce43f9aa8526d9ebaf563d",
    "pythagoras": "4b7d759a80ce28f8f693b26ae7600679d19ac16fa6313857e8ed69e5b55f279f",
    "derivative": "13793b92c67b65b6eb7da7d4efbbb1728164b849f71bc3453119843ac52bed86",
    "vectors": "76cc991e2036979d448cac8536a241f0ce9144070d780afd73dc9727c85b1594",
}


@pytest.mark.parametrize("topic", ["sine", "pythagoras", "derivative", "vectors"])
def test_scene_output_pinned(topic):
    assert hashlib.sha256(render(topic).encode()).hexdigest() == SCENE_SHA256[topic]


@pytest.mark.parametrize(
    "alias,canonical",
    [
        ("unit circle", "sine"),
        ("Trigonometry", "sine"),
        ("pythagorean theorem", "pythagoras"),
        ("tangent-line", "derivative"),
        ("vector addition", "vectors"),
    ],
)
def test_aliases_resolve(alias, canonical):
    assert render(alias) == render(canonical)


def test_unknown_topic_raises():
    with pytest.raises(KeyError):
        render("fourier transform")


def test_unknown_topic_without_title_or_steps_still_raises():
    with pytest.raises(KeyError):
        render("fourier transform", title="Fourier series")
    with pytest.raises(KeyError):
        render("fourier transform", steps=["a", "b"])


def test_unknown_topic_with_title_and_steps_renders_generic_scene():
    svg = render("fourier_series", title="Fourier series", steps=["Step one", "Step two"])
    assert svg.startswith("<svg")
    assert svg.rstrip().endswith("</svg>")
    parseString(svg)
    assert "Fourier series" in svg
    assert "Step one" in svg and "Step two" in svg


def test_canonical_topic_ignores_title_and_steps():
    # Hand-built scenes stay pinned regardless of what title/steps a caller passes.
    assert render("sine", title="ignored", steps=["ignored"]) == render("sine")


def test_alias_synonym_does_not_hijack_a_generic_request_with_title_and_steps():
    # "triangle" is a loose ALIASES synonym for pythagoras, but title/steps signal the
    # caller wants a genuinely different on-the-fly animation — that must win over the
    # synonym match (regression: alias normalization used to short-circuit before the
    # generic path could ever see title/steps).
    svg = render("triangle", title="Triangle inequality", steps=["|a+b| <= |a| + |b|"])
    assert svg != render("pythagoras")
    assert "Triangle inequality" in svg


def test_alias_synonym_still_resolves_without_title_or_steps():
    # Without title/steps there's no on-the-fly signal, so the alias fallback still helps a
    # loosely-worded topic hit a hand-built scene.
    assert render("triangle") == render("pythagoras")


def test_generic_scene_escapes_untrusted_text():
    # title/steps are model-authored free text rendered via the browser's innerHTML, so any
    # markup must be neutralized (no new tag/attribute can be opened) rather than spliced
    # into the SVG verbatim.
    svg = build_generic_svg("<script>alert(1)</script>", ["<img src=x onerror=alert(1)>"])
    assert "<script>" not in svg
    assert "<img" not in svg
    assert "&lt;script&gt;" in svg
    assert "&lt;img" in svg
    parseString(svg)  # still well-formed XML despite the hostile input


def test_generic_scene_caps_step_count_and_length():
    steps = [f"step {i}" for i in range(20)]
    svg = build_generic_svg("Many steps", steps)
    assert svg.count("<text") == 1 + 1 + 6  # title + progress indicator + at most MAX_GENERIC_STEPS lines
    long_step = "x" * 500
    svg = build_generic_svg("Long step", [long_step])
    assert "x" * 500 not in svg


def test_generic_scene_falls_back_when_all_steps_blank():
    svg = build_generic_svg("Empty", ["", "   "])
    assert "(no details provided)" in svg


def test_generic_scene_current_step_is_the_only_fully_visible_one():
    # Voice-paced reveal: everything is always in the SVG (so it can render the same shape
    # regardless of position), but only current_step is opacity="1" — earlier steps are
    # dimmed (already covered), later ones hidden (not reached yet).
    steps = ["first", "second", "third"]
    svg = build_generic_svg("Title", steps, current_step=1)
    assert 'font-size="18" opacity="1">second<' in svg
    assert 'font-size="18" opacity="0.35">first<' in svg
    assert 'font-size="18" opacity="0">third<' in svg


def test_generic_scene_clamps_current_step_to_bounds():
    steps = ["first", "second"]
    assert 'opacity="1">first<' in build_generic_svg("Title", steps, current_step=-1)
    assert 'opacity="1">second<' in build_generic_svg("Title", steps, current_step=99)


def test_generic_scene_title_shows_step_progress():
    # Title and progress render as separate elements (not concatenated) so a near-max-length
    # title can't push the progress indicator off-viewport or get clipped itself.
    svg = build_generic_svg("Fourier series", ["a", "b", "c"], current_step=1)
    assert "Fourier series" in svg
    assert "step 2/3" in svg


def test_sine_structure_preserved():
    # The migrated sine scene keeps its original 6 animated attributes.
    svg = build_sine_svg(samples=8)
    assert svg.count("<animate ") == 6
    assert '<circle cx="150" cy="150" r="100"' in svg


@pytest.mark.parametrize(
    "builder", [build_sine_svg, build_derivative_svg, build_pythagoras_svg, build_vectors_svg]
)
def test_builders_reject_non_positive_duration(builder):
    with pytest.raises(ValueError):
        builder(duration=0)


@pytest.mark.parametrize("builder", [build_sine_svg, build_derivative_svg])
def test_sampled_builders_reject_zero_samples(builder):
    with pytest.raises(ValueError):
        builder(samples=0)


@pytest.mark.parametrize("builder", [build_sine_svg, build_derivative_svg])
def test_sampled_builders_reject_fractional_samples_below_one(builder):
    # A samples count between 0 and 1 (e.g. 0.5) must raise ValueError here, not fall through
    # to a confusing TypeError out of range(samples + 1) once the builder starts iterating.
    with pytest.raises(ValueError):
        builder(samples=0.5)
