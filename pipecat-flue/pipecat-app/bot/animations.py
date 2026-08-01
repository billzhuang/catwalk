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

# Shared viewport (every scene but pythagoras, which needs extra vertical room for its squares).
STANDARD_WIDTH, STANDARD_HEIGHT = 650, 300
PYTHAGORAS_WIDTH, PYTHAGORAS_HEIGHT = 650, 340

# Shared palette (kept consistent across scenes so the presentation reads as one thing).
BG_COLOR = "#1a1a2e"
CIRCLE_COLOR = "#f5c518"   # yellow
DOT_COLOR = "#4fc3f7"      # blue
CURVE_COLOR = "#ff6b6b"    # red
GREEN = "#7bd88f"
AXIS_COLOR = "#888888"
TEXT_COLOR = "#eeeeee"


def _join_decimals(values, precision):
    """Join `values`, each formatted to `precision` decimal places, with ';' — the SMIL
    animate values/keyTimes list format _values_attr and _key_times_attr below both build,
    just at different precisions (2 for coordinates, 4 for keyTimes)."""
    return ";".join(f"{v:.{precision}f}" for v in values)


def _values_attr(points, index):
    return _join_decimals((p[index] for p in points), 2)


def _xy_values(points):
    """cx/cy (or x1/y1, x2/y2, ...) animate-value strings for a list of (x, y) points —
    the pair of _values_attr calls every animated point list in this file computes."""
    return _values_attr(points, 0), _values_attr(points, 1)


def _key_times_attr(fracs):
    return _join_decimals(fracs, 4)


def _validate_at_least(name, value, minimum, *, inclusive):
    """Shared guard for the duration/samples parameters every builder takes: duration must be
    > 0 (minimum=0, exclusive) and samples must be >= 1 (minimum=1, inclusive) — a fractional
    samples count like 0.5 must still be rejected here, not left to fail later as a confusing
    TypeError out of range()."""
    if value < minimum or (not inclusive and value == minimum):
        requirement = f"at least {minimum}" if inclusive else f"greater than {minimum}"
        raise ValueError(f"{name} must be {requirement}")


def _animate_tag(attribute_name, values, key_times, duration, *, transform_type=None):
    """A looping SMIL <animate>/<animateTransform> tag. Every scene's animated attributes
    share the same dur/repeatCount shape, so each call site only supplies what varies."""
    tag = "animateTransform" if transform_type else "animate"
    type_attr = f' type="{transform_type}"' if transform_type else ""
    return (
        f'<{tag} attributeName="{attribute_name}"{type_attr} values="{values}" '
        f'keyTimes="{key_times}" dur="{duration}s" repeatCount="indefinite"/>'
    )


def _animate_xy_tag(x_attr, y_attr, x_values, y_values, key_times, duration):
    """Two <animate> tags animating a paired x/y attribute (cx/cy, x1/y1, x2/y2, ...) on the
    same keyTimes/duration timeline — the shape every animated point in build_sine_svg,
    build_derivative_svg, and build_vectors_svg repeats. Joined with the same "\\n    "
    indentation the call sites' own template lines already used, so replacing two separate
    _animate_tag lines with one _animate_xy_tag call leaves the rendered SVG unchanged."""
    return f'{_animate_tag(x_attr, x_values, key_times, duration)}\n    {_animate_tag(y_attr, y_values, key_times, duration)}'


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


def _wrap_scene(width, height, title, body, *, title_y=24, head=None):
    """The <svg>+title-block+</svg> wrapper every scene builder returns, factored out so a new
    scene can't drift on the width/height pair or forget the closing tag. `head` (used only by
    build_vectors_svg's <defs> block) is spliced between the opening tag and the title block;
    `body` is the scene-specific content between the title block and </svg>, exactly as each
    builder used to inline it."""
    head_block = f"{head}\n" if head else ""
    return f'''{_svg_open(width, height)}
{head_block}{_title_block(width, height, title, title_y)}
{body}
</svg>
'''


def _text_tag(x, y, fill, text, *, font_size=15, opacity=None, text_anchor=None):
    """A <text> element with the font-family every scene shares; font size and the optional
    opacity/text-anchor attributes vary per call site."""
    extra = ""
    if text_anchor:
        extra += f' text-anchor="{text_anchor}"'
    if opacity is not None:
        extra += f' opacity="{opacity}"'
    return f'<text x="{x}" y="{y}" fill="{fill}" font-family="sans-serif" font-size="{font_size}"{extra}>{text}</text>'


def _path_from_points(points):
    """SVG path 'd' data for a polyline through `points`: 'M' for the first point, 'L' for
    every point after. Shared by build_sine_svg's static curve trace and
    _static_curve_path's sampled function curve, which otherwise each re-derive the same
    M/L-per-point join."""
    return " ".join(f"{'M' if i == 0 else 'L'}{x:.2f},{y:.2f}" for i, (x, y) in enumerate(points))


def _animated_dot(color, start, cx_values, cy_values, key_times, duration, *, r=5):
    """A radius-`r` dot at `start`, animated along cx/cy — the shape build_sine_svg's rotating
    and traced dots and build_derivative_svg's sweeping dot each repeat, differing only in
    color/start point/value strings."""
    x, y = start
    return (
        f'  <circle r="{r}" fill="{color}" cx="{x:.2f}" cy="{y:.2f}">\n'
        f'    {_animate_xy_tag("cx", "cy", cx_values, cy_values, key_times, duration)}\n'
        f'  </circle>'
    )


def _pulsing_square(points, color, animate_tag):
    """A translucent square: matching fill/stroke color, fill-opacity 0.2, stroke-width 2,
    wrapping one <animate> tag for its own pulsing fill-opacity. The shape all three squares
    in build_pythagoras_svg share, differing only in points/color/animate_tag."""
    return (
        f'  <polygon points="{points}" fill="{color}" fill-opacity="0.2" stroke="{color}" stroke-width="2">\n'
        f'    {animate_tag}\n'
        f'  </polygon>'
    )


def _axis_line(x1, y1, x2, y2):
    """A reference axis line: the shared stroke color/width (AXIS_COLOR, width 1) every plain
    axis line in this file uses — build_sine_svg draws three (a horizontal curve baseline, a
    horizontal axis, a vertical axis) and build_derivative_svg two (a horizontal axis, a
    vertical axis), each previously hand-rolling this same `<line ... stroke-width="1"/>` shape."""
    return f'  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{AXIS_COLOR}" stroke-width="1"/>'


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
CIRCLE_CX, CIRCLE_CY, RADIUS = 150, 150, 100
CURVE_X0, CURVE_X1 = 300, 620
SAMPLES = 120
DURATION_SECONDS = 6.0


def _circle_point(theta: float) -> tuple[float, float]:
    """Point on the unit circle (SVG coords, y grows downward) at angle theta."""
    return CIRCLE_CX + RADIUS * math.cos(theta), CIRCLE_CY - RADIUS * math.sin(theta)


def _curve_point(theta: float, t_frac: float) -> tuple[float, float]:
    """Point on the traced sine curve for angle theta at animation fraction t_frac."""
    return CURVE_X0 + t_frac * (CURVE_X1 - CURVE_X0), CIRCLE_CY - RADIUS * math.sin(theta)


def _fracs(samples: int) -> list[float]:
    """`samples + 1` evenly spaced fractions in [0, 1], looping to start."""
    return [i / samples for i in range(samples + 1)]


def _sample_frames(samples: int = SAMPLES) -> list[tuple[float, float]]:
    """`samples + 1` (theta, t_frac) pairs over one full rotation, looping to start."""
    return [(2 * math.pi * t, t) for t in _fracs(samples)]


def build_sine_svg(samples=SAMPLES, duration=DURATION_SECONDS) -> str:
    _validate_at_least("samples", samples, 1, inclusive=True)
    _validate_at_least("duration", duration, 0, inclusive=False)
    frames = _sample_frames(samples)
    circle_points = [_circle_point(theta) for theta, _ in frames]
    curve_points = [_curve_point(theta, t) for theta, t in frames]
    key_times = _key_times_attr([t for _, t in frames])

    dot_cx, dot_cy = _xy_values(circle_points)
    trace_cx, trace_cy = _xy_values(curve_points)

    static_curve_path = _path_from_points(curve_points)
    start_x, start_y = circle_points[0]

    body = f'''
{_axis_line(CURVE_X0, CIRCLE_CY, CURVE_X1, CIRCLE_CY)}
{_axis_line(CIRCLE_CX - RADIUS - 10, CIRCLE_CY, CIRCLE_CX + RADIUS + 10, CIRCLE_CY)}
{_axis_line(CIRCLE_CX, CIRCLE_CY - RADIUS - 10, CIRCLE_CX, CIRCLE_CY + RADIUS + 10)}

  <circle cx="{CIRCLE_CX}" cy="{CIRCLE_CY}" r="{RADIUS}" fill="none" stroke="{CIRCLE_COLOR}" stroke-width="2"/>
  <path d="{static_curve_path}" fill="none" stroke="{CURVE_COLOR}" stroke-width="1" stroke-opacity="0.25"/>

  <line x1="{CIRCLE_CX}" y1="{CIRCLE_CY}" x2="{start_x:.2f}" y2="{start_y:.2f}" stroke="{DOT_COLOR}" stroke-width="2">
    {_animate_xy_tag("x2", "y2", dot_cx, dot_cy, key_times, duration)}
  </line>

{_animated_dot(DOT_COLOR, circle_points[0], dot_cx, dot_cy, key_times, duration)}

{_animated_dot(CURVE_COLOR, curve_points[0], trace_cx, trace_cy, key_times, duration)}'''
    return _wrap_scene(STANDARD_WIDTH, STANDARD_HEIGHT, "Unit circle rotation traces the sine wave", body)


# ---------------------------------------------------------------------------
# pythagoras — squares on a right triangle, a^2 + b^2 = c^2
# ---------------------------------------------------------------------------
def build_pythagoras_svg(duration=4.0) -> str:
    _validate_at_least("duration", duration, 0, inclusive=False)
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

    # a_square and b_square pulse in lockstep on the same timeline; c_square pulses later, on its own.
    leg_square_kt = "0;0.5;1"
    leg_pulse = _animate_tag("fill-opacity", "0.15;0.6;0.15", leg_square_kt, duration)

    body = f'''
{_pulsing_square(a_square, DOT_COLOR, leg_pulse)}
{_pulsing_square(b_square, CIRCLE_COLOR, leg_pulse)}
{_pulsing_square(c_square, CURVE_COLOR, _animate_tag("fill-opacity", "0.15;0.15;0.7;0.15", "0;0.35;0.6;1", duration))}

  <polygon points="{ax},{ay} {bx},{by} {cx},{cy}" fill="none" stroke="{TEXT_COLOR}" stroke-width="2.5"/>
  <rect x="{cx}" y="{cy - 14}" width="14" height="14" fill="none" stroke="{AXIS_COLOR}" stroke-width="1"/>

  {_text_tag(f"{(cx + bx) / 2 - 4}", f"{cy + (bx - cx) / 2 + 5}", DOT_COLOR, "a²")}
  {_text_tag(f"{cx - (cy - ay) / 2 - 8}", f"{(ay + cy) / 2 + 5}", CIRCLE_COLOR, "b²")}
  {_text_tag(f"{(ax + bx) / 2 + nx / 2 - 6}", f"{(ay + by) / 2 + ny / 2 + 5}", CURVE_COLOR, "c²")}'''
    return _wrap_scene(PYTHAGORAS_WIDTH, PYTHAGORAS_HEIGHT, "Pythagorean theorem: a² + b² = c²", body, title_y=26)


# ---------------------------------------------------------------------------
# derivative — tangent line sliding along y = x^2, slope = 2x
# ---------------------------------------------------------------------------
def _static_curve_path(to_screen, f, x_min, x_max, steps=60):
    """Static background curve path for y=f(x) over [x_min, x_max], sampled into `steps`
    segments — the same "sample and project" shape as `_sample_frames`, for a curve that
    isn't animated so has no separate fraction/key-time axis."""
    pts = []
    for i in range(steps + 1):
        x = x_min + (x_max - x_min) * i / steps
        pts.append(to_screen(x, f(x)))
    return _path_from_points(pts)


def _tangent_sweep_frames(fracs, amp, f, fp, half, to_screen):
    """(dot, tangent-left-end, tangent-right-end) screen points for each animation fraction,
    as the tangent point sweeps x = amp*sin(2*pi*t) across the curve."""
    dots, tan1, tan2 = [], [], []
    for t in fracs:
        x = amp * math.sin(2 * math.pi * t)  # oscillates -amp..amp, loops cleanly
        dots.append(to_screen(x, f(x)))
        tan1.append(to_screen(x - half, f(x) - fp(x) * half))
        tan2.append(to_screen(x + half, f(x) + fp(x) * half))
    return dots, tan1, tan2


def build_derivative_svg(samples=120, duration=6.0) -> str:
    _validate_at_least("samples", samples, 1, inclusive=True)
    _validate_at_least("duration", duration, 0, inclusive=False)
    ox, oy, sx, sy = 325.0, 250.0, 70.0, 28.0  # origin + px-per-unit
    amp, half = 1.8, 0.8                        # sweep amplitude, tangent half-width

    def f(x):
        return x * x

    def fp(x):
        return 2 * x

    def to_screen(x, y):
        return ox + sx * x, oy - sy * y

    parabola = _static_curve_path(to_screen, f, -2.1, 2.1)

    fracs = _fracs(samples)
    dots, tan1, tan2 = _tangent_sweep_frames(fracs, amp, f, fp, half, to_screen)

    kt = _key_times_attr(fracs)
    dot_cx, dot_cy = _xy_values(dots)
    x1v, y1v = _xy_values(tan1)
    x2v, y2v = _xy_values(tan2)
    l0, r0 = tan1[0]

    ax0, ay0 = to_screen(-2.4, 0)
    ax1, ay1 = to_screen(2.4, 0)
    body = f'''
{_axis_line(f"{ax0:.1f}", f"{ay0:.1f}", f"{ax1:.1f}", f"{ay1:.1f}")}
{_axis_line(ox, 40, ox, 270)}
  <path d="{parabola}" fill="none" stroke="{CIRCLE_COLOR}" stroke-width="2"/>

  <line x1="{l0:.2f}" y1="{r0:.2f}" x2="{tan2[0][0]:.2f}" y2="{tan2[0][1]:.2f}" stroke="{CURVE_COLOR}" stroke-width="2.5">
    {_animate_xy_tag("x1", "y1", x1v, y1v, kt, duration)}
    {_animate_xy_tag("x2", "y2", x2v, y2v, kt, duration)}
  </line>

{_animated_dot(DOT_COLOR, dots[0], dot_cx, dot_cy, kt, duration)}'''
    return _wrap_scene(
        STANDARD_WIDTH, STANDARD_HEIGHT, "The derivative is the slope of the tangent: f(x)=x², f\u2032(x)=2x", body
    )


# ---------------------------------------------------------------------------
# vectors — tip-to-tail addition, a + b = resultant
# ---------------------------------------------------------------------------
def _translate(point, vector):
    """`point` shifted by `vector` — the "tip of a vector rooted at `point`" shape
    build_vectors_svg computes three times: vector a's own tip, vector b's own tip, and
    the tip of a+b (the resultant), the last one composed with _add below."""
    return point[0] + vector[0], point[1] + vector[1]


def _add(u, v):
    """Componentwise vector sum, e.g. a+b for build_vectors_svg's resultant tip."""
    return u[0] + v[0], u[1] + v[1]


def build_vectors_svg(duration=5.0) -> str:
    _validate_at_least("duration", duration, 0, inclusive=False)
    ox, oy = 130.0, 250.0          # origin
    a = (150.0, -70.0)             # vector a
    b = (90.0, -110.0)             # vector b
    axp, ayp = _translate((ox, oy), a)          # tip of a
    bxp, byp = _translate((ox, oy), b)          # tip of b
    rxp, ryp = _translate((ox, oy), _add(a, b))  # tip of a+b (resultant)

    # b slides from the origin (dashed ghost) to the tip of a (tip-to-tail), in lockstep with the
    # resultant arrow growing from the origin to the tip of a+b — both share this same timeline.
    slide = f"0 0;0 0;{a[0]} {a[1]};{a[0]} {a[1]}"
    sweep_kt = "0;0.15;0.55;1"
    defs = f'''  <defs>
{_arrow_marker("arrow-b", GREEN)}
{_arrow_marker("arrow-a", DOT_COLOR)}
{_arrow_marker("arrow-r", CURVE_COLOR)}
  </defs>'''
    body = f'''
  <line x1="{ox}" y1="{oy}" x2="{bxp:.1f}" y2="{byp:.1f}" stroke="{GREEN}" stroke-width="1.5" stroke-dasharray="4 4" stroke-opacity="0.4"/>

  <line x1="{ox}" y1="{oy}" x2="{axp:.1f}" y2="{ayp:.1f}" stroke="{DOT_COLOR}" stroke-width="3" marker-end="url(#arrow-a)"/>
  {_text_tag(f"{(ox + axp) / 2 - 6:.1f}", f"{(oy + ayp) / 2 + 20:.1f}", DOT_COLOR, "a")}

  <line x1="{ox}" y1="{oy}" x2="{bxp:.1f}" y2="{byp:.1f}" stroke="{GREEN}" stroke-width="3" marker-end="url(#arrow-b)">
    {_animate_tag("transform", slide, sweep_kt, duration, transform_type="translate")}
  </line>
  {_text_tag(f"{(axp + rxp) / 2 - 6:.1f}", f"{(ayp + ryp) / 2 + 20:.1f}", GREEN, "b")}

  <line x1="{ox}" y1="{oy}" x2="{ox}" y2="{oy}" stroke="{CURVE_COLOR}" stroke-width="3" marker-end="url(#arrow-r)">
    {_animate_xy_tag("x2", "y2", f"{ox};{ox};{rxp:.1f};{rxp:.1f}", f"{oy};{oy};{ryp:.1f};{ryp:.1f}", sweep_kt, duration)}
  </line>
  {_text_tag(f"{rxp + 8:.1f}", f"{ryp - 6:.1f}", CURVE_COLOR, "a+b")}'''
    return _wrap_scene(
        STANDARD_WIDTH, STANDARD_HEIGHT, "Vector addition, tip to tail: a + b = a+b", body, title_y=26, head=defs
    )


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
        lines.append(f'  {_text_tag(30, y, TEXT_COLOR, text, font_size=18, opacity=opacity)}')

    safe_title = escape(title.strip()[:MAX_GENERIC_TITLE])
    # A separate right-aligned element, not appended to the title text, so a near-max-length
    # title (MAX_GENERIC_TITLE=80, matching flue-agent's schema cap) can't push the progress
    # indicator past the 650px viewport or get clipped itself.
    progress = f'  {_text_tag(STANDARD_WIDTH - 10, 26, TEXT_COLOR, f"step {current_step + 1}/{n}", font_size=14, text_anchor="end", opacity=0.7)}'
    body = f"{progress}\n{chr(10).join(lines)}"
    return _wrap_scene(STANDARD_WIDTH, STANDARD_HEIGHT, safe_title, body, title_y=26)


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


def _has_generic_content(title: str | None, steps: list[str] | None) -> bool:
    """Mirrors flue-agent's hasGenericContent, which itself only needs to check
    `title?.trim()`/`steps?.length` because its callers already went through titleSchema/
    stepsSchema (each trimmed and non-empty) first. render() has no such upstream schema — it's
    reachable directly from /animation-svg/{topic}'s raw, unvalidated query params (see
    run_bot.py) — so this checks each step is non-blank after trimming too, not just that the
    list is non-empty."""
    return bool(title and title.strip()) and bool(steps) and all(s.strip() for s in steps)


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
    if _has_generic_content(title, steps):
        return build_generic_svg(title, steps, current_step)
    alias_key = _normalize(topic)
    if alias_key in SCENES:
        return SCENES[alias_key]()
    raise KeyError(topic)


def list_topics() -> list[str]:
    return sorted(SCENES)
