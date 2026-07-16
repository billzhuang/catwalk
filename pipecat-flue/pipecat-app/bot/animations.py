"""3Blue1Brown-style math animations as self-contained animated SVGs.

Pure Python (stdlib only, no matplotlib/manim/ffmpeg). Each scene returns a
standalone SVG string that plays natively via SVG/SMIL — no JavaScript. The bot
serves these at GET /animation-svg/<topic> and the browser client switches into
its full-screen presentation layout when flue's show_math_animation tool fires.

The `sine` scene is the original unit-circle-traces-the-sine-wave visual
(previously math-animation/animate.py); `pythagoras`, `derivative`, and
`vectors` are new. `render(topic)` is the whitelisted entry point.
"""
from __future__ import annotations

import math
from typing import Callable
from xml.sax.saxutils import escape

# Shared palette (kept consistent across scenes so the presentation reads as one thing).
BG_COLOR = "#1a1a2e"
CIRCLE_COLOR = "#f5c518"   # yellow
DOT_COLOR = "#4fc3f7"      # blue
CURVE_COLOR = "#ff6b6b"    # red
GREEN = "#7bd88f"
AXIS_COLOR = "#888888"
TEXT_COLOR = "#eeeeee"


def _values_attr(points, index):
    return ";".join(f"{p[index]:.2f}" for p in points)


def _key_times_attr(fracs):
    return ";".join(f"{t:.4f}" for t in fracs)


def _validate_duration(duration):
    if duration <= 0:
        raise ValueError("duration must be positive")


def _validate_samples(samples):
    if samples < 1:
        raise ValueError("samples must be at least 1")


def _animate_tag(attribute_name, values, key_times, duration, *, transform_type=None):
    """A looping SMIL <animate>/<animateTransform> tag. Every scene's animated attributes
    share the same dur/repeatCount shape, so each call site only supplies what varies."""
    tag = "animateTransform" if transform_type else "animate"
    type_attr = f' type="{transform_type}"' if transform_type else ""
    return (
        f'<{tag} attributeName="{attribute_name}"{type_attr} values="{values}" '
        f'keyTimes="{key_times}" dur="{duration}s" repeatCount="indefinite"/>'
    )


def _svg_open(width, height):
    """The root <svg> tag every scene opens with, sized to its own viewBox."""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}">'
    )


def _title_block(width, height, title, title_y=24):
    """The background <rect> + title <text> every scene shows right after <svg>."""
    return (
        f'  <rect width="{width}" height="{height}" fill="{BG_COLOR}"/>\n'
        f'  <text x="10" y="{title_y}" fill="{TEXT_COLOR}" font-family="sans-serif" '
        f'font-size="16">{title}</text>'
    )


def _label_tag(x, y, fill, text):
    """A small annotation label (e.g. "a²", "a+b"). Every scene's labels share the same
    font-family/font-size; only position, color, and content vary per call site."""
    return f'<text x="{x}" y="{y}" fill="{fill}" font-family="sans-serif" font-size="15">{text}</text>'


def _arrow_marker(marker_id, color):
    """A <marker> arrowhead for a line's marker-end. Every arrow shares the same geometry;
    only the id (referenced via url(#id)) and fill color vary per call site."""
    return (
        f'    <marker id="{marker_id}" viewBox="0 0 10 10" refX="8" refY="5" '
        f'markerWidth="7" markerHeight="7" orient="auto-start-reverse">\n'
        f'      <path d="M0,0 L10,5 L0,10 z" fill="{color}"/>\n'
        f'    </marker>'
    )


# ---------------------------------------------------------------------------
# sine — unit circle rotation traces the sine wave
# ---------------------------------------------------------------------------
SINE_WIDTH, SINE_HEIGHT = 650, 300
CIRCLE_CX, CIRCLE_CY, RADIUS = 150, 150, 100
CURVE_X0, CURVE_X1 = 300, 620
SAMPLES = 120
DURATION_SECONDS = 6.0


def circle_point(theta):
    """Point on the unit circle (SVG coords, y grows downward) at angle theta."""
    return CIRCLE_CX + RADIUS * math.cos(theta), CIRCLE_CY - RADIUS * math.sin(theta)


def curve_point(theta, t_frac):
    """Point on the traced sine curve for angle theta at animation fraction t_frac."""
    return CURVE_X0 + t_frac * (CURVE_X1 - CURVE_X0), CIRCLE_CY - RADIUS * math.sin(theta)


def sample_frames(samples=SAMPLES):
    """`samples + 1` (theta, t_frac) pairs over one full rotation, looping to start."""
    return [(2 * math.pi * i / samples, i / samples) for i in range(samples + 1)]


def build_sine_svg(samples=SAMPLES, duration=DURATION_SECONDS) -> str:
    _validate_samples(samples)
    _validate_duration(duration)
    frames = sample_frames(samples)
    circle_points = [circle_point(theta) for theta, _ in frames]
    curve_points = [curve_point(theta, t) for theta, t in frames]
    key_times = _key_times_attr([t for _, t in frames])

    dot_cx, dot_cy = _values_attr(circle_points, 0), _values_attr(circle_points, 1)
    trace_cx, trace_cy = _values_attr(curve_points, 0), _values_attr(curve_points, 1)

    static_curve_path = " ".join(
        f"{'M' if i == 0 else 'L'}{x:.2f},{y:.2f}" for i, (x, y) in enumerate(curve_points)
    )
    start_x, start_y = circle_points[0]

    return f'''{_svg_open(SINE_WIDTH, SINE_HEIGHT)}
{_title_block(SINE_WIDTH, SINE_HEIGHT, "Unit circle rotation traces the sine wave")}

  <line x1="{CURVE_X0}" y1="{CIRCLE_CY}" x2="{CURVE_X1}" y2="{CIRCLE_CY}" stroke="{AXIS_COLOR}" stroke-width="1"/>
  <line x1="{CIRCLE_CX - RADIUS - 10}" y1="{CIRCLE_CY}" x2="{CIRCLE_CX + RADIUS + 10}" y2="{CIRCLE_CY}" stroke="{AXIS_COLOR}" stroke-width="1"/>
  <line x1="{CIRCLE_CX}" y1="{CIRCLE_CY - RADIUS - 10}" x2="{CIRCLE_CX}" y2="{CIRCLE_CY + RADIUS + 10}" stroke="{AXIS_COLOR}" stroke-width="1"/>

  <circle cx="{CIRCLE_CX}" cy="{CIRCLE_CY}" r="{RADIUS}" fill="none" stroke="{CIRCLE_COLOR}" stroke-width="2"/>
  <path d="{static_curve_path}" fill="none" stroke="{CURVE_COLOR}" stroke-width="1" stroke-opacity="0.25"/>

  <line x1="{CIRCLE_CX}" y1="{CIRCLE_CY}" x2="{start_x:.2f}" y2="{start_y:.2f}" stroke="{DOT_COLOR}" stroke-width="2">
    {_animate_tag("x2", dot_cx, key_times, duration)}
    {_animate_tag("y2", dot_cy, key_times, duration)}
  </line>

  <circle r="5" fill="{DOT_COLOR}" cx="{start_x:.2f}" cy="{start_y:.2f}">
    {_animate_tag("cx", dot_cx, key_times, duration)}
    {_animate_tag("cy", dot_cy, key_times, duration)}
  </circle>

  <circle r="5" fill="{CURVE_COLOR}" cx="{curve_points[0][0]:.2f}" cy="{curve_points[0][1]:.2f}">
    {_animate_tag("cx", trace_cx, key_times, duration)}
    {_animate_tag("cy", trace_cy, key_times, duration)}
  </circle>
</svg>
'''


# ---------------------------------------------------------------------------
# pythagoras — squares on a right triangle, a^2 + b^2 = c^2
# ---------------------------------------------------------------------------
def build_pythagoras_svg(duration=4.0) -> str:
    _validate_duration(duration)
    # Right angle at C; horizontal leg a (C->B), vertical leg b (A->C).
    ax, ay = 250.0, 150.0   # A (top of vertical leg)
    bx, by = 340.0, 220.0   # B (right of horizontal leg)
    cx, cy = 250.0, 220.0   # C (right angle)

    a_square = f"{cx},{cy} {bx},{by} {bx},{by + (bx - cx)} {cx},{cy + (bx - cx)}"      # on leg a, below
    b_square = f"{ax},{ay} {cx},{cy} {cx - (cy - ay)},{cy} {ax - (cy - ay)},{ay}"      # on leg b, left
    # Square on the hypotenuse, on the outward side (away from C).
    hx, hy = bx - ax, by - ay
    nx, ny = hy, -hx  # outward normal (same length as AB)
    c_square = f"{ax},{ay} {bx},{by} {bx + nx},{by + ny} {ax + nx},{ay + ny}"

    return f'''{_svg_open(650, 340)}
{_title_block(650, 340, "Pythagorean theorem: a² + b² = c²", 26)}

  <polygon points="{a_square}" fill="{DOT_COLOR}" fill-opacity="0.2" stroke="{DOT_COLOR}" stroke-width="2">
    {_animate_tag("fill-opacity", "0.15;0.6;0.15", "0;0.5;1", duration)}
  </polygon>
  <polygon points="{b_square}" fill="{CIRCLE_COLOR}" fill-opacity="0.2" stroke="{CIRCLE_COLOR}" stroke-width="2">
    {_animate_tag("fill-opacity", "0.15;0.6;0.15", "0;0.5;1", duration)}
  </polygon>
  <polygon points="{c_square}" fill="{CURVE_COLOR}" fill-opacity="0.2" stroke="{CURVE_COLOR}" stroke-width="2">
    {_animate_tag("fill-opacity", "0.15;0.15;0.7;0.15", "0;0.35;0.6;1", duration)}
  </polygon>

  <polygon points="{ax},{ay} {bx},{by} {cx},{cy}" fill="none" stroke="{TEXT_COLOR}" stroke-width="2.5"/>
  <rect x="{cx}" y="{cy - 14}" width="14" height="14" fill="none" stroke="{AXIS_COLOR}" stroke-width="1"/>

  {_label_tag(f"{(cx + bx) / 2 - 4}", f"{cy + (bx - cx) / 2 + 5}", DOT_COLOR, "a²")}
  {_label_tag(f"{cx - (cy - ay) / 2 - 8}", f"{(ay + cy) / 2 + 5}", CIRCLE_COLOR, "b²")}
  {_label_tag(f"{(ax + bx) / 2 + nx / 2 - 6}", f"{(ay + by) / 2 + ny / 2 + 5}", CURVE_COLOR, "c²")}
</svg>
'''


# ---------------------------------------------------------------------------
# derivative — tangent line sliding along y = x^2, slope = 2x
# ---------------------------------------------------------------------------
def build_derivative_svg(samples=120, duration=6.0) -> str:
    _validate_samples(samples)
    _validate_duration(duration)
    ox, oy, sx, sy = 325.0, 250.0, 70.0, 28.0  # origin + px-per-unit
    amp, half = 1.8, 0.8                        # sweep amplitude, tangent half-width

    def f(x):
        return x * x

    def fp(x):
        return 2 * x

    def to_screen(x, y):
        return ox + sx * x, oy - sy * y

    # Static parabola for x in [-2.1, 2.1].
    pts = []
    steps = 60
    for i in range(steps + 1):
        x = -2.1 + 4.2 * i / steps
        px, py = to_screen(x, f(x))
        pts.append(f"{'M' if i == 0 else 'L'}{px:.2f},{py:.2f}")
    parabola = " ".join(pts)

    dots, tan1, tan2, fracs = [], [], [], []
    for i in range(samples + 1):
        t = i / samples
        x = amp * math.sin(2 * math.pi * t)  # oscillates -amp..amp, loops cleanly
        px, py = to_screen(x, f(x))
        lx, ly = to_screen(x - half, f(x) - fp(x) * half)
        rx, ry = to_screen(x + half, f(x) + fp(x) * half)
        dots.append((px, py))
        tan1.append((lx, ly)); tan2.append((rx, ry))
        fracs.append(t)

    kt = _key_times_attr(fracs)
    dot_cx, dot_cy = _values_attr(dots, 0), _values_attr(dots, 1)
    x1v, y1v = _values_attr(tan1, 0), _values_attr(tan1, 1)
    x2v, y2v = _values_attr(tan2, 0), _values_attr(tan2, 1)
    l0, r0 = tan1[0]

    ax0, ay0 = to_screen(-2.4, 0)
    ax1, ay1 = to_screen(2.4, 0)
    return f'''{_svg_open(650, 300)}
{_title_block(650, 300, "The derivative is the slope of the tangent: f(x)=x², f′(x)=2x")}

  <line x1="{ax0:.1f}" y1="{ay0:.1f}" x2="{ax1:.1f}" y2="{ay1:.1f}" stroke="{AXIS_COLOR}" stroke-width="1"/>
  <line x1="{ox}" y1="40" x2="{ox}" y2="270" stroke="{AXIS_COLOR}" stroke-width="1"/>
  <path d="{parabola}" fill="none" stroke="{CIRCLE_COLOR}" stroke-width="2"/>

  <line x1="{l0:.2f}" y1="{r0:.2f}" x2="{tan2[0][0]:.2f}" y2="{tan2[0][1]:.2f}" stroke="{CURVE_COLOR}" stroke-width="2.5">
    {_animate_tag("x1", x1v, kt, duration)}
    {_animate_tag("y1", y1v, kt, duration)}
    {_animate_tag("x2", x2v, kt, duration)}
    {_animate_tag("y2", y2v, kt, duration)}
  </line>

  <circle r="5" fill="{DOT_COLOR}" cx="{dots[0][0]:.2f}" cy="{dots[0][1]:.2f}">
    {_animate_tag("cx", dot_cx, kt, duration)}
    {_animate_tag("cy", dot_cy, kt, duration)}
  </circle>
</svg>
'''


# ---------------------------------------------------------------------------
# vectors — tip-to-tail addition, a + b = resultant
# ---------------------------------------------------------------------------
def build_vectors_svg(duration=5.0) -> str:
    _validate_duration(duration)
    ox, oy = 130.0, 250.0          # origin
    a = (150.0, -70.0)             # vector a
    b = (90.0, -110.0)             # vector b
    axp, ayp = ox + a[0], oy + a[1]        # tip of a
    rxp, ryp = ox + a[0] + b[0], oy + a[1] + b[1]  # tip of a+b (resultant)

    # b slides from the origin (dashed ghost) to the tip of a (tip-to-tail).
    slide = f"0 0;0 0;{a[0]} {a[1]};{a[0]} {a[1]}"
    return f'''{_svg_open(650, 300)}
  <defs>
{_arrow_marker("arrow-b", GREEN)}
{_arrow_marker("arrow-a", DOT_COLOR)}
{_arrow_marker("arrow-r", CURVE_COLOR)}
  </defs>
{_title_block(650, 300, "Vector addition, tip to tail: a + b = a+b", 26)}

  <line x1="{ox}" y1="{oy}" x2="{ox + b[0]:.1f}" y2="{oy + b[1]:.1f}" stroke="{GREEN}" stroke-width="1.5" stroke-dasharray="4 4" stroke-opacity="0.4"/>

  <line x1="{ox}" y1="{oy}" x2="{axp:.1f}" y2="{ayp:.1f}" stroke="{DOT_COLOR}" stroke-width="3" marker-end="url(#arrow-a)"/>
  {_label_tag(f"{(ox + axp) / 2 - 6:.1f}", f"{(oy + ayp) / 2 + 20:.1f}", DOT_COLOR, "a")}

  <line x1="{ox}" y1="{oy}" x2="{ox + b[0]:.1f}" y2="{oy + b[1]:.1f}" stroke="{GREEN}" stroke-width="3" marker-end="url(#arrow-b)">
    {_animate_tag("transform", slide, "0;0.15;0.55;1", duration, transform_type="translate")}
  </line>

  <line x1="{ox}" y1="{oy}" x2="{ox}" y2="{oy}" stroke="{CURVE_COLOR}" stroke-width="3" marker-end="url(#arrow-r)">
    {_animate_tag("x2", f"{ox};{ox};{rxp:.1f};{rxp:.1f}", "0;0.15;0.55;1", duration)}
    {_animate_tag("y2", f"{oy};{oy};{ryp:.1f};{ryp:.1f}", "0;0.15;0.55;1", duration)}
  </line>
  {_label_tag(f"{rxp + 8:.1f}", f"{ryp - 6:.1f}", CURVE_COLOR, "a+b")}
</svg>
'''


# ---------------------------------------------------------------------------
# generic — on-the-fly scene for a topic with no hand-built builder: a title plus a
# few short steps. Unlike the hand-built scenes' continuous SMIL loops, these steps are
# voice-paced (flue's control_math_animation tool) rather than revealed on a timer: every
# step is always in the SVG, but only `current_step` is fully visible (opacity 1); earlier
# steps stay dimly visible (already covered) and later ones are hidden (not yet reached).
# Title/steps are model-authored free text (flue's show_math_animation tool), so every
# piece of text is XML-escaped before it is spliced into the SVG string — this is the only
# scene fed untrusted text, and the client renders the response via innerHTML, so an
# unescaped "<"/"&" could both break the SVG and (via a stray <script>/on*= attribute)
# execute in the browser.
# ---------------------------------------------------------------------------
GENERIC_WIDTH, GENERIC_HEIGHT = 650, 300
MAX_GENERIC_TITLE = 80
# SVG <text> doesn't auto-wrap; at 18px font size, much beyond this many characters would
# overflow the 650px-wide viewport starting from x=30 and get clipped rather than wrap.
MAX_GENERIC_STEP = 65
MAX_GENERIC_STEPS = 6
STEP_DONE_OPACITY = 0.35


def build_generic_svg(title: str, steps: list[str], current_step: int = 0) -> str:
    steps = [s for s in steps if s and s.strip()][:MAX_GENERIC_STEPS] or ["(no details provided)"]
    n = len(steps)
    current_step = max(0, min(current_step, n - 1))
    line_height = 34
    start_y = 80

    lines = []
    for i, raw in enumerate(steps):
        text = escape(raw.strip()[:MAX_GENERIC_STEP])
        y = start_y + i * line_height
        opacity = 1 if i == current_step else (STEP_DONE_OPACITY if i < current_step else 0)
        lines.append(
            f'  <text x="30" y="{y}" fill="{TEXT_COLOR}" font-family="sans-serif" '
            f'font-size="18" opacity="{opacity}">{text}</text>'
        )

    safe_title = escape(title.strip()[:MAX_GENERIC_TITLE])
    # A separate right-aligned element, not appended to the title text, so a near-max-length
    # title (MAX_GENERIC_TITLE=80, matching flue-agent's schema cap) can't push the progress
    # indicator past the 650px viewport or get clipped itself.
    progress = (
        f'  <text x="{GENERIC_WIDTH - 10}" y="26" fill="{TEXT_COLOR}" font-family="sans-serif" '
        f'font-size="14" text-anchor="end" opacity="0.7">step {current_step + 1}/{n}</text>'
    )
    return f'''{_svg_open(GENERIC_WIDTH, GENERIC_HEIGHT)}
{_title_block(GENERIC_WIDTH, GENERIC_HEIGHT, safe_title, 26)}
{progress}
{chr(10).join(lines)}
</svg>
'''


# ---------------------------------------------------------------------------
# Registry + whitelisted entry point
# ---------------------------------------------------------------------------
SCENES: dict[str, Callable[[], str]] = {
    "sine": build_sine_svg,
    "pythagoras": build_pythagoras_svg,
    "derivative": build_derivative_svg,
    "vectors": build_vectors_svg,
}

# Synonyms the model might emit -> canonical scene key.
ALIASES = {
    "unit_circle": "sine", "sine_wave": "sine", "sinewave": "sine", "cosine": "sine",
    "trig": "sine", "trigonometry": "sine",
    "pythagorean": "pythagoras", "pythagorean_theorem": "pythagoras",
    "pythagoras_theorem": "pythagoras", "right_triangle": "pythagoras", "triangle": "pythagoras",
    "derivatives": "derivative", "tangent": "derivative", "tangent_line": "derivative",
    "slope": "derivative", "calculus": "derivative",
    "vector": "vectors", "vector_addition": "vectors", "vector_sum": "vectors",
}


def _normalize_exact(topic: str) -> str:
    """Case/whitespace/dash normalization only — no alias/synonym expansion."""
    return (topic or "").strip().lower().replace(" ", "_").replace("-", "_")


def _normalize(topic: str) -> str:
    return ALIASES.get(_normalize_exact(topic), _normalize_exact(topic))


def render(
    topic: str, *, title: str | None = None, steps: list[str] | None = None, current_step: int = 0
) -> str:
    """Return the SVG for a topic.

    An exact canonical topic (SCENES, modulo case/whitespace) always uses its own hand-built
    builder — title/steps/current_step are ignored so its output stays pinned (those scenes
    loop continuously and have no discrete steps). Otherwise, if title and at least one step
    are given, that's a caller signaling an on-the-fly request, so it renders via
    build_generic_svg() even if the topic string happens to also be a broad ALIASES synonym
    (e.g. "triangle" -> pythagoras) — the caller's title/steps take precedence over a loose
    synonym match. With no title/steps, alias normalization is used as a fallback so a
    spoken/loosely-worded topic can still hit a hand-built scene. Raises KeyError if nothing
    matches (whitelist)."""
    exact_key = _normalize_exact(topic)
    if exact_key in SCENES:
        return SCENES[exact_key]()
    if title and steps:
        return build_generic_svg(title, steps, current_step)
    alias_key = _normalize(topic)
    if alias_key in SCENES:
        return SCENES[alias_key]()
    raise KeyError(topic)


def list_topics() -> list[str]:
    return sorted(SCENES)
