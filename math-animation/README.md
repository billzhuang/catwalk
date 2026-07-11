# math-animation

A small, self-contained 3Blue1Brown-style math visualization: rotating a
point around the unit circle traces out the sine wave. Pure Python
(stdlib only — no matplotlib/manim/ffmpeg), mirroring the zero-dependency
style of the root demo (`server.py`).

## Run it

```bash
python3 animate.py output.svg   # writes an animated SVG
```

Open `output.svg` in any browser — the animation plays natively via SVG/SMIL,
no JavaScript required.

## Test

```bash
python3 -m unittest test_animate -v
```
