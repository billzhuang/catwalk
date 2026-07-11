import math
import unittest

from animate import (
    CIRCLE_CX,
    CIRCLE_CY,
    CURVE_X0,
    CURVE_X1,
    RADIUS,
    SAMPLES,
    build_svg,
    circle_point,
    curve_point,
    sample_frames,
)


class CirclePointTests(unittest.TestCase):
    def test_angle_zero_is_rightmost_point(self):
        x, y = circle_point(0)
        self.assertAlmostEqual(x, CIRCLE_CX + RADIUS)
        self.assertAlmostEqual(y, CIRCLE_CY)

    def test_quarter_turn_is_topmost_point(self):
        x, y = circle_point(math.pi / 2)
        self.assertAlmostEqual(x, CIRCLE_CX)
        self.assertAlmostEqual(y, CIRCLE_CY - RADIUS)

    def test_half_turn_is_leftmost_point(self):
        x, y = circle_point(math.pi)
        self.assertAlmostEqual(x, CIRCLE_CX - RADIUS)
        self.assertAlmostEqual(y, CIRCLE_CY)


class CurvePointTests(unittest.TestCase):
    def test_x_interpolates_linearly_with_t_frac(self):
        x, _ = curve_point(0, 0.0)
        self.assertAlmostEqual(x, CURVE_X0)
        x, _ = curve_point(0, 1.0)
        self.assertAlmostEqual(x, CURVE_X1)
        x, _ = curve_point(0, 0.5)
        self.assertAlmostEqual(x, (CURVE_X0 + CURVE_X1) / 2)

    def test_y_tracks_sine_of_theta(self):
        _, y = curve_point(math.pi / 2, 0.0)
        self.assertAlmostEqual(y, CIRCLE_CY - RADIUS)
        _, y = curve_point(0, 0.0)
        self.assertAlmostEqual(y, CIRCLE_CY)


class SampleFramesTests(unittest.TestCase):
    def test_loops_back_to_start(self):
        frames = sample_frames(SAMPLES)
        self.assertEqual(len(frames), SAMPLES + 1)
        first_theta, first_t = frames[0]
        last_theta, last_t = frames[-1]
        self.assertAlmostEqual(first_theta, 0.0)
        self.assertAlmostEqual(first_t, 0.0)
        self.assertAlmostEqual(last_theta, 2 * math.pi)
        self.assertAlmostEqual(last_t, 1.0)

    def test_custom_sample_count(self):
        frames = sample_frames(4)
        self.assertEqual(len(frames), 5)


class BuildSvgTests(unittest.TestCase):
    def test_is_deterministic(self):
        self.assertEqual(build_svg(), build_svg())

    def test_contains_expected_structure(self):
        svg = build_svg(samples=8)
        self.assertTrue(svg.startswith("<svg"))
        self.assertTrue(svg.rstrip().endswith("</svg>"))
        self.assertIn('<circle cx="150" cy="150" r="100"', svg)
        self.assertEqual(svg.count("<animate "), 6)
        self.assertIn("repeatCount=\"indefinite\"", svg)

    def test_key_times_span_zero_to_one(self):
        svg = build_svg(samples=4)
        self.assertIn('keyTimes="0.0000;0.2500;0.5000;0.7500;1.0000"', svg)


if __name__ == "__main__":
    unittest.main()
