"""3Blue1Brown-style animation: unit-circle rotation traces the sine wave.

Pure Python (stdlib only, no matplotlib/manim/ffmpeg) — generates a
self-contained animated SVG, in keeping with this repo's zero-dependency
demo style (see root server.py). Open the output file directly in a browser;
the animation runs via native SVG/SMIL, no JavaScript needed.
"""

import math
import sys

WIDTH = 650
HEIGHT = 300
CIRCLE_CX = 150
CIRCLE_CY = 150
RADIUS = 100
CURVE_X0 = 300
CURVE_X1 = 620
DURATION_SECONDS = 6.0
SAMPLES = 120

BG_COLOR = "#1a1a2e"
CIRCLE_COLOR = "#f5c518"
DOT_COLOR = "#4fc3f7"
CURVE_COLOR = "#ff6b6b"
AXIS_COLOR = "#888888"


def circle_point(theta):
    """Point on the unit circle (SVG coords, y grows downward) at angle theta."""
    x = CIRCLE_CX + RADIUS * math.cos(theta)
    y = CIRCLE_CY - RADIUS * math.sin(theta)
    return x, y


def curve_point(theta, t_frac):
    """Point on the traced sine curve for angle theta at animation fraction t_frac."""
    x = CURVE_X0 + t_frac * (CURVE_X1 - CURVE_X0)
    y = CIRCLE_CY - RADIUS * math.sin(theta)
    return x, y


def sample_frames(samples=SAMPLES):
    """`samples + 1` (theta, t_frac) pairs over one full rotation, looping back to start."""
    return [(2 * math.pi * i / samples, i / samples) for i in range(samples + 1)]


def _values_attr(points, index):
    return ";".join(f"{p[index]:.2f}" for p in points)


def _key_times_attr(frames):
    return ";".join(f"{t:.4f}" for _, t in frames)


def _animate_tag(attribute, values, key_times, duration):
    return (
        f'<animate attributeName="{attribute}" values="{values}" '
        f'keyTimes="{key_times}" dur="{duration}s" repeatCount="indefinite"/>'
    )


def build_svg(samples=SAMPLES, duration=DURATION_SECONDS):
    if samples < 1:
        raise ValueError("samples must be at least 1")
    if duration <= 0:
        raise ValueError("duration must be positive")
    frames = sample_frames(samples)
    circle_points = [circle_point(theta) for theta, _ in frames]
    curve_points = [curve_point(theta, t) for theta, t in frames]
    key_times = _key_times_attr(frames)

    dot_cx, dot_cy = _values_attr(circle_points, 0), _values_attr(circle_points, 1)
    trace_cx, trace_cy = _values_attr(curve_points, 0), _values_attr(curve_points, 1)

    static_curve_path = " ".join(
        f"{'M' if i == 0 else 'L'}{x:.2f},{y:.2f}"
        for i, (x, y) in enumerate(curve_points)
    )
    start_x, start_y = circle_points[0]

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}"
     width="{WIDTH}" height="{HEIGHT}">
  <rect width="{WIDTH}" height="{HEIGHT}" fill="{BG_COLOR}"/>
  <text x="10" y="24" fill="#eeeeee" font-family="sans-serif" font-size="16">Unit circle rotation traces the sine wave</text>

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


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    out_path = argv[0] if argv else "output.svg"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(build_svg())
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
