"""Every animation scene renders to well-formed, looping SVG, and render() is
a whitelist. No network, no services."""
import hashlib
import json
import re
from xml.dom.minidom import parseString

import pytest

from bot.animations import (
    ALIASES,
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
from tests.conftest import read_pipecat_flue_file


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


def test_vectors_scene_labels_all_three_vectors():
    # Regression: build_vectors_svg labeled "a" and the resultant "a+b" but never labeled
    # "b" itself, leaving a viewer no way to tell which arrow is which.
    svg = build_vectors_svg()
    assert re.search(r"<text[^>]*>a</text>", svg)
    assert re.search(r"<text[^>]*>b</text>", svg)
    assert re.search(r"<text[^>]*>a\+b</text>", svg)


def test_topics_match_flue_agent_and_client():
    """The four hand-built topics are declared independently in three places — SCENES here,
    ANIMATION_TOPICS in flue-agent/src/animation.ts, and the topic chips in
    pipecat-app/client/index.html — with nothing enforcing they stay in sync. Pins that all
    three agree, so a topic added/renamed/removed in one place without the others fails here
    instead of silently drifting (e.g. a client chip for a topic bot/animations.py can't
    actually render as a hand-built scene, or vice versa)."""
    animation_ts = read_pipecat_flue_file("flue-agent/src/animation.ts")
    ts_list = re.search(r"ANIMATION_TOPICS = \[(.*?)\]", animation_ts, re.DOTALL)
    assert ts_list, "couldn't find ANIMATION_TOPICS in animation.ts"
    ts_topics = sorted(re.findall(r"'([^']+)'", ts_list.group(1)))

    index_html = read_pipecat_flue_file("pipecat-app/client/index.html")
    html_topics = sorted(set(re.findall(r'data-topic="([^"]+)"', index_html)))

    assert ts_topics == list_topics()
    assert html_topics == list_topics()


def test_generic_limits_loaded_from_shared_limits_file():
    """The generic-scene length caps here (MAX_GENERIC_STEP/STEPS/TITLE) let a title/steps
    string through unclipped only if flue-agent's show_math_animation tool schema already
    rejected anything longer — the two sides must agree or the model could send text this SVG
    renderer clips (schema cap too loose) or the schema could reject text the SVG would have
    rendered fine (schema cap too tight). Both animations.py and flue-agent's animation.ts now
    load animation-limits.json (at the pipecat-flue root) at startup, so they agree by
    construction; this pins that the file actually loads into these constants unchanged."""
    shared = json.loads(read_pipecat_flue_file("animation-limits.json"))
    assert shared == {
        "maxSteps": MAX_GENERIC_STEPS,
        "maxStepLength": MAX_GENERIC_STEP,
        "maxTitleLength": MAX_GENERIC_TITLE,
    }


def test_aliases_loaded_from_shared_topics_file():
    """ALIASES lets a loosely-worded topic (e.g. "cosine") still resolve to a hand-built scene,
    but only when render() gets no title/steps — flue-agent's show_math_animation only calls
    render() without title/steps when its own isCanonicalTopic() recognizes the topic, so the
    two sides' alias tables must agree or an alias one side treats as canonical and the other
    doesn't would either force the model into title/steps unnecessarily, or (worse) let an alias
    reach render() bare and raise KeyError. Both ALIASES here and flue-agent's ANIMATION_ALIASES
    now load animation-topics.json (at the pipecat-flue root) at startup, so they agree by
    construction; this pins that the file actually loads into ALIASES unchanged and that every
    value is a topic SCENES can render, catching a bad hand-edit to the JSON on either side."""
    shared = json.loads(read_pipecat_flue_file("animation-topics.json"))
    assert shared == ALIASES
    assert set(ALIASES.values()) <= set(SCENES)


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
    "vectors": "cc49164cb07490eff42108d6257029c58bb8bce069be680b59c048f95886aa04",
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


def test_alias_synonym_with_blank_title_falls_back_to_hand_built_scene():
    # /animation-svg/{topic} passes raw, unvalidated query params straight to render() (unlike
    # flue-agent's show_math_animation, which trims/rejects a blank title via titleSchema first),
    # so a whitespace-only title must not count as "real" on-the-fly content — otherwise this
    # would render a blank-titled generic scene instead of falling back to pythagoras.
    assert render("triangle", title="   ", steps=["a real step"]) == render("pythagoras")


def test_alias_synonym_with_all_blank_steps_falls_back_to_hand_built_scene():
    # Same as above but for steps: a list of only whitespace strings carries no real content.
    assert render("triangle", title="Real title", steps=["   ", ""]) == render("pythagoras")


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


def test_generic_scene_truncates_step_at_exact_cap_boundary():
    """test_generic_limits_match_flue_agent_schema only pins the numeric cap constants in
    sync across languages; it never exercises the actual slicing. This asserts the step text
    is kept up to (not beyond) MAX_GENERIC_STEP chars, so an off-by-one in the `[:MAX_GENERIC_STEP]`
    slice would fail here even though the constant itself is still correct."""
    svg = build_generic_svg("Title", ["x" * (MAX_GENERIC_STEP + 25)])
    assert "x" * MAX_GENERIC_STEP in svg
    assert "x" * (MAX_GENERIC_STEP + 1) not in svg


def test_generic_scene_truncates_title_at_exact_cap_boundary():
    svg = build_generic_svg("T" * (MAX_GENERIC_TITLE + 25), ["step"])
    assert "T" * MAX_GENERIC_TITLE in svg
    assert "T" * (MAX_GENERIC_TITLE + 1) not in svg


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


@pytest.mark.parametrize("builder", [build_sine_svg, build_derivative_svg])
def test_sampled_builders_reject_fractional_samples_at_or_above_one(builder):
    # A fractional samples count >= 1 (e.g. 1.5) passes the bounds check in _validate_at_least
    # but must still raise ValueError here, not fall through to a confusing TypeError out of
    # range(samples + 1) once the builder starts iterating.
    with pytest.raises(ValueError):
        builder(samples=1.5)


@pytest.mark.parametrize("builder", [build_sine_svg, build_derivative_svg])
def test_sampled_builders_reject_bool_samples(builder):
    # bool is an int subclass in Python, so isinstance(samples, int) alone would silently
    # accept True/False as a sample count; the integer check must exclude bool explicitly.
    with pytest.raises(ValueError):
        builder(samples=True)
