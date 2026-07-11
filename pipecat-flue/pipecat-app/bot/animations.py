"""3Blue1Brown-style math animations as self-contained animated SVGs.

Pure Python (stdlib only, no matplotlib/manim/ffmpeg). Each scene returns a
standalone SVG string that plays natively via SVG/SMIL — no JavaScript. The bot
serves these at GET /animation-svg/<topic> and the browser client drops the SVG
straight into a popup when flue's show_math_animation tool fires.

The `sine` scene is the original unit-circle-traces-the-sine-wave visual
(previously math-animation/animate.py); `pythagoras`, `derivative`, and
`vectors` are new. `render(topic)` is the whitelisted entry point.
"""
from __future__ import annotations

import math
from typing import Callable

# Shared palette (kept consistent across scenes so the popup reads as one thing).
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
    if samples < 1:
        raise ValueError("samples must be at least 1")
    if duration <= 0:
        raise ValueError("duration must be positive")
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

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SINE_WIDTH} {SINE_HEIGHT}"
     width="{SINE_WIDTH}" height="{SINE_HEIGHT}">
  <rect width="{SINE_WIDTH}" height="{SINE_HEIGHT}" fill="{BG_COLOR}"/>
  <text x="10" y="24" fill="{TEXT_COLOR}" font-family="sans-serif" font-size="16">Unit circle rotation traces the sine wave</text>

  <line x1="{CURVE_X0}" y1="{CIRCLE_CY}" x2="{CURVE_X1}" y2="{CIRCLE_CY}" stroke="{AXIS_COLOR}" stroke-width="1"/>
  <line x1="{CIRCLE_CX - RADIUS - 10}" y1="{CIRCLE_CY}" x2="{CIRCLE_CX + RADIUS + 10}" y2="{CIRCLE_CY}" stroke="{AXIS_COLOR}" stroke-width="1"/>
  <line x1="{CIRCLE_CX}" y1="{CIRCLE_CY - RADIUS - 10}" x2="{CIRCLE_CX}" y2="{CIRCLE_CY + RADIUS + 10}" stroke="{AXIS_COLOR}" stroke-width="1"/>

  <circle cx="{CIRCLE_CX}" cy="{CIRCLE_CY}" r="{RADIUS}" fill="none" stroke="{CIRCLE_COLOR}" stroke-width="2"/>
  <path d="{static_curve_path}" fill="none" stroke="{CURVE_COLOR}" stroke-width="1" stroke-opacity="0.25"/>

  <line x1="{CIRCLE_CX}" y1="{CIRCLE_CY}" x2="{start_x:.2f}" y2="{start_y:.2f}" stroke="{DOT_COLOR}" stroke-width="2">
    <animate attributeName="x2" values="{dot_cx}" keyTimes="{key_times}" dur="{duration}s" repeatCount="indefinite"/>
    <animate attributeName="y2" values="{dot_cy}" keyTimes="{key_times}" dur="{duration}s" repeatCount="indefinite"/>
  </line>

  <circle r="5" fill="{DOT_COLOR}" cx="{start_x:.2f}" cy="{start_y:.2f}">
    <animate attributeName="cx" values="{dot_cx}" keyTimes="{key_times}" dur="{duration}s" repeatCount="indefinite"/>
    <animate attributeName="cy" values="{dot_cy}" keyTimes="{key_times}" dur="{duration}s" repeatCount="indefinite"/>
  </circle>

  <circle r="5" fill="{CURVE_COLOR}" cx="{curve_points[0][0]:.2f}" cy="{curve_points[0][1]:.2f}">
    <animate attributeName="cx" values="{trace_cx}" keyTimes="{key_times}" dur="{duration}s" repeatCount="indefinite"/>
    <animate attributeName="cy" values="{trace_cy}" keyTimes="{key_times}" dur="{duration}s" repeatCount="indefinite"/>
  </circle>
</svg>
'''


# ---------------------------------------------------------------------------
# pythagoras — squares on a right triangle, a^2 + b^2 = c^2
# ---------------------------------------------------------------------------
def build_pythagoras_svg(duration=4.0) -> str:
    if duration <= 0:
        raise ValueError("duration must be positive")
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

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 650 340" width="650" height="340">
  <rect width="650" height="340" fill="{BG_COLOR}"/>
  <text x="10" y="26" fill="{TEXT_COLOR}" font-family="sans-serif" font-size="16">Pythagorean theorem: a² + b² = c²</text>

  <polygon points="{a_square}" fill="{DOT_COLOR}" fill-opacity="0.2" stroke="{DOT_COLOR}" stroke-width="2">
    <animate attributeName="fill-opacity" values="0.15;0.6;0.15" keyTimes="0;0.5;1" dur="{duration}s" repeatCount="indefinite"/>
  </polygon>
  <polygon points="{b_square}" fill="{CIRCLE_COLOR}" fill-opacity="0.2" stroke="{CIRCLE_COLOR}" stroke-width="2">
    <animate attributeName="fill-opacity" values="0.15;0.6;0.15" keyTimes="0;0.5;1" dur="{duration}s" repeatCount="indefinite"/>
  </polygon>
  <polygon points="{c_square}" fill="{CURVE_COLOR}" fill-opacity="0.2" stroke="{CURVE_COLOR}" stroke-width="2">
    <animate attributeName="fill-opacity" values="0.15;0.15;0.7;0.15" keyTimes="0;0.35;0.6;1" dur="{duration}s" repeatCount="indefinite"/>
  </polygon>

  <polygon points="{ax},{ay} {bx},{by} {cx},{cy}" fill="none" stroke="{TEXT_COLOR}" stroke-width="2.5"/>
  <rect x="{cx}" y="{cy - 14}" width="14" height="14" fill="none" stroke="{AXIS_COLOR}" stroke-width="1"/>

  <text x="{(cx + bx) / 2 - 4}" y="{cy + (bx - cx) / 2 + 5}" fill="{DOT_COLOR}" font-family="sans-serif" font-size="15">a²</text>
  <text x="{cx - (cy - ay) / 2 - 8}" y="{(ay + cy) / 2 + 5}" fill="{CIRCLE_COLOR}" font-family="sans-serif" font-size="15">b²</text>
  <text x="{(ax + bx) / 2 + nx / 2 - 6}" y="{(ay + by) / 2 + ny / 2 + 5}" fill="{CURVE_COLOR}" font-family="sans-serif" font-size="15">c²</text>
</svg>
'''


# ---------------------------------------------------------------------------
# derivative — tangent line sliding along y = x^2, slope = 2x
# ---------------------------------------------------------------------------
def build_derivative_svg(samples=120, duration=6.0) -> str:
    if samples < 1:
        raise ValueError("samples must be at least 1")
    if duration <= 0:
        raise ValueError("duration must be positive")
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

    dots, tan_x1, tan_y1, tan_x2, tan_y2, fracs = [], [], [], [], [], []
    for i in range(samples + 1):
        t = i / samples
        x = amp * math.sin(2 * math.pi * t)  # oscillates -amp..amp, loops cleanly
        px, py = to_screen(x, f(x))
        lx, ly = to_screen(x - half, f(x) - fp(x) * half)
        rx, ry = to_screen(x + half, f(x) + fp(x) * half)
        dots.append((px, py))
        tan_x1.append((lx,)); tan_y1.append((ly,)); tan_x2.append((rx,)); tan_y2.append((ry,))
        fracs.append(t)

    kt = _key_times_attr(fracs)
    dot_cx, dot_cy = _values_attr(dots, 0), _values_attr(dots, 1)
    x1v = ";".join(f"{p[0]:.2f}" for p in tan_x1)
    y1v = ";".join(f"{p[0]:.2f}" for p in tan_y1)
    x2v = ";".join(f"{p[0]:.2f}" for p in tan_x2)
    y2v = ";".join(f"{p[0]:.2f}" for p in tan_y2)
    l0, r0 = tan_x1[0][0], tan_y1[0][0]

    ax0, ay0 = to_screen(-2.4, 0)
    ax1, ay1 = to_screen(2.4, 0)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 650 300" width="650" height="300">
  <rect width="650" height="300" fill="{BG_COLOR}"/>
  <text x="10" y="24" fill="{TEXT_COLOR}" font-family="sans-serif" font-size="16">The derivative is the slope of the tangent: f(x)=x², f′(x)=2x</text>

  <line x1="{ax0:.1f}" y1="{ay0:.1f}" x2="{ax1:.1f}" y2="{ay1:.1f}" stroke="{AXIS_COLOR}" stroke-width="1"/>
  <line x1="{ox}" y1="40" x2="{ox}" y2="270" stroke="{AXIS_COLOR}" stroke-width="1"/>
  <path d="{parabola}" fill="none" stroke="{CIRCLE_COLOR}" stroke-width="2"/>

  <line x1="{l0:.2f}" y1="{r0:.2f}" x2="{tan_x2[0][0]:.2f}" y2="{tan_y2[0][0]:.2f}" stroke="{CURVE_COLOR}" stroke-width="2.5">
    <animate attributeName="x1" values="{x1v}" keyTimes="{kt}" dur="{duration}s" repeatCount="indefinite"/>
    <animate attributeName="y1" values="{y1v}" keyTimes="{kt}" dur="{duration}s" repeatCount="indefinite"/>
    <animate attributeName="x2" values="{x2v}" keyTimes="{kt}" dur="{duration}s" repeatCount="indefinite"/>
    <animate attributeName="y2" values="{y2v}" keyTimes="{kt}" dur="{duration}s" repeatCount="indefinite"/>
  </line>

  <circle r="5" fill="{DOT_COLOR}" cx="{dots[0][0]:.2f}" cy="{dots[0][1]:.2f}">
    <animate attributeName="cx" values="{dot_cx}" keyTimes="{kt}" dur="{duration}s" repeatCount="indefinite"/>
    <animate attributeName="cy" values="{dot_cy}" keyTimes="{kt}" dur="{duration}s" repeatCount="indefinite"/>
  </circle>
</svg>
'''


# ---------------------------------------------------------------------------
# vectors — tip-to-tail addition, a + b = resultant
# ---------------------------------------------------------------------------
def build_vectors_svg(duration=5.0) -> str:
    if duration <= 0:
        raise ValueError("duration must be positive")
    ox, oy = 130.0, 250.0          # origin
    a = (150.0, -70.0)             # vector a
    b = (90.0, -110.0)             # vector b
    axp, ayp = ox + a[0], oy + a[1]        # tip of a
    rxp, ryp = ox + a[0] + b[0], oy + a[1] + b[1]  # tip of a+b (resultant)

    # b slides from the origin (dashed ghost) to the tip of a (tip-to-tail).
    slide = f"0 0;0 0;{a[0]} {a[1]};{a[0]} {a[1]}"
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 650 300" width="650" height="300">
  <defs>
    <marker id="arrow-b" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="{GREEN}"/>
    </marker>
    <marker id="arrow-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="{DOT_COLOR}"/>
    </marker>
    <marker id="arrow-r" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="{CURVE_COLOR}"/>
    </marker>
  </defs>
  <rect width="650" height="300" fill="{BG_COLOR}"/>
  <text x="10" y="26" fill="{TEXT_COLOR}" font-family="sans-serif" font-size="16">Vector addition, tip to tail: a + b = a+b</text>

  <line x1="{ox}" y1="{oy}" x2="{ox + b[0]:.1f}" y2="{oy + b[1]:.1f}" stroke="{GREEN}" stroke-width="1.5" stroke-dasharray="4 4" stroke-opacity="0.4"/>

  <line x1="{ox}" y1="{oy}" x2="{axp:.1f}" y2="{ayp:.1f}" stroke="{DOT_COLOR}" stroke-width="3" marker-end="url(#arrow-a)"/>
  <text x="{(ox + axp) / 2 - 6:.1f}" y="{(oy + ayp) / 2 + 20:.1f}" fill="{DOT_COLOR}" font-family="sans-serif" font-size="15">a</text>

  <line x1="{ox}" y1="{oy}" x2="{ox + b[0]:.1f}" y2="{oy + b[1]:.1f}" stroke="{GREEN}" stroke-width="3" marker-end="url(#arrow-b)">
    <animateTransform attributeName="transform" type="translate" values="{slide}" keyTimes="0;0.15;0.55;1" dur="{duration}s" repeatCount="indefinite"/>
  </line>

  <line x1="{ox}" y1="{oy}" x2="{ox}" y2="{oy}" stroke="{CURVE_COLOR}" stroke-width="3" marker-end="url(#arrow-r)">
    <animate attributeName="x2" values="{ox};{ox};{rxp:.1f};{rxp:.1f}" keyTimes="0;0.15;0.55;1" dur="{duration}s" repeatCount="indefinite"/>
    <animate attributeName="y2" values="{oy};{oy};{ryp:.1f};{ryp:.1f}" keyTimes="0;0.15;0.55;1" dur="{duration}s" repeatCount="indefinite"/>
  </line>
  <text x="{rxp + 8:.1f}" y="{ryp - 6:.1f}" fill="{CURVE_COLOR}" font-family="sans-serif" font-size="15">a+b</text>
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


def _normalize(topic: str) -> str:
    key = (topic or "").strip().lower().replace(" ", "_").replace("-", "_")
    return ALIASES.get(key, key)


def render(topic: str) -> str:
    """Return the SVG for a topic. Raises KeyError for unknown topics (whitelist)."""
    key = _normalize(topic)
    if key not in SCENES:
        raise KeyError(topic)
    return SCENES[key]()


def list_topics() -> list[str]:
    return sorted(SCENES)
