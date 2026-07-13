"""Every animation scene renders to well-formed, looping SVG, and render() is
a whitelist. No network, no services."""
import hashlib
from xml.dom.minidom import parseString

import pytest

from bot.animations import (
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


def test_render_is_deterministic():
    assert render("sine") == render("sine")
    assert render("vectors") == render("vectors")


# Characterization test pinning exact byte-for-byte SVG output (default params) so an
# internal refactor of the <animate>/<animateTransform> tag-building code can be verified
# to change nothing observable.
SCENE_SHA256 = {
    "sine": "cde16028230819ab8031d62d799269a0bdd0895a0e5a4583056423721e79881c",
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
    assert "<animate" in svg
    assert "Fourier series" in svg
    assert "Step one" in svg and "Step two" in svg


def test_canonical_topic_ignores_title_and_steps():
    # Hand-built scenes stay pinned regardless of what title/steps a caller passes.
    assert render("sine", title="ignored", steps=["ignored"]) == render("sine")


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
    assert svg.count("<text") == 1 + 6  # title + at most MAX_GENERIC_STEPS lines
    long_step = "x" * 500
    svg = build_generic_svg("Long step", [long_step])
    assert "x" * 500 not in svg


def test_generic_scene_falls_back_when_all_steps_blank():
    svg = build_generic_svg("Empty", ["", "   "])
    assert "(no details provided)" in svg


def test_generic_scene_rejects_non_positive_duration():
    with pytest.raises(ValueError):
        build_generic_svg("Title", ["a step"], duration=0)


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
