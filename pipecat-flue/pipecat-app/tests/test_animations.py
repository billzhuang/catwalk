"""Every animation scene renders to well-formed, looping SVG, and render() is
a whitelist. No network, no services."""
from xml.dom.minidom import parseString

import pytest

from bot.animations import (
    SCENES,
    build_derivative_svg,
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
