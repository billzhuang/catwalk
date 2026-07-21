import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { withSpan } from './telemetry.ts';

/** Canonical animation topics with a hand-built scene (bot/animations.py SCENES). Any other
 *  topic is rendered on the fly from the `title`/`steps` the model supplies (see below). */
export const ANIMATION_TOPICS = ['sine', 'pythagoras', 'derivative', 'vectors'] as const;
export type AnimationTopic = (typeof ANIMATION_TOPICS)[number];

const MAX_STEPS = 6;
// SVG <text> doesn't auto-wrap; at the generic scene's 18px font size a step much longer
// than this would overflow the 650px-wide viewport and get clipped (bot/animations.py
// MAX_GENERIC_STEP mirrors this).
const MAX_STEP_LENGTH = 65;

// Mirrors bot/animations.py's _normalize_exact() — that's what actually decides whether a
// topic string hits a hand-built SCENES entry, so canonical detection here must agree with it.
// Otherwise a case/whitespace/dash variant of a canonical name (e.g. "Pythagoras") would be
// misjudged as on-the-fly here — forcing the model to invent title/steps — while pipecat still
// routes it to the pinned hand-built scene and silently discards them.
function normalizeExactTopic(topic: string): string {
  return topic.trim().toLowerCase().replaceAll(' ', '_').replaceAll('-', '_');
}

// Synonyms the model might loosely emit for one of the four hand-built topics above. Mirrors
// bot/animations.py's ALIASES dict line for line — kept in sync by
// test_aliases_match_flue_agent_schema in pipecat-app/tests/test_animations.py. Without this,
// isCanonicalTopic would only recognize an exact canonical name, forcing every alias (e.g.
// "cosine") through the title/steps path — and since pipecat's render() always prefers
// title/steps over its own ALIASES lookup when both are present, that lookup could never
// actually fire, leaving it dead code despite its "loosely-worded topic still hits a hand-built
// scene" doc comment.
const ANIMATION_ALIASES: Record<string, AnimationTopic> = {
  unit_circle: 'sine',
  sine_wave: 'sine',
  sinewave: 'sine',
  cosine: 'sine',
  trig: 'sine',
  trigonometry: 'sine',
  pythagorean: 'pythagoras',
  pythagorean_theorem: 'pythagoras',
  pythagoras_theorem: 'pythagoras',
  right_triangle: 'pythagoras',
  triangle: 'pythagoras',
  derivatives: 'derivative',
  tangent: 'derivative',
  tangent_line: 'derivative',
  slope: 'derivative',
  calculus: 'derivative',
  vector: 'vectors',
  vector_addition: 'vectors',
  vector_sum: 'vectors',
};

function isCanonicalTopic(topic: string): boolean {
  const normalized = normalizeExactTopic(topic);
  return (ANIMATION_TOPICS as readonly string[]).includes(normalized) || normalized in ANIMATION_ALIASES;
}

/** True if show_math_animation's args are enough to actually render something: a canonical
 *  topic (title/steps ignored), or a non-canonical one with both a title and at least one
 *  step. Shared by the tool's own run() (which throws on false) and app.ts's observe()
 *  handler (which silently skips storing state on false) so the two can't drift apart —
 *  storing state that can't render leaves the browser polling a topic bot/animations.py's
 *  render() will 404 on. `title`/`steps` are checked post-trim: the tool's own valibot schema
 *  trims and enforces minLength(1) on both, but observe()'s raw event args haven't gone
 *  through that schema, so a whitespace-only title or step would otherwise look renderable
 *  here and then fail that schema validation in run() — the exact bug this function exists
 *  to prevent, just one layer deeper. */
export function isRenderableAnimationInput(topic: string, title?: string, steps?: string[]): boolean {
  return (
    isCanonicalTopic(topic) ||
    Boolean(title?.trim() && steps?.length && steps.every((s) => s.trim().length > 0))
  );
}

/** Instruction section for this tool — composed into the agent prompt by buildInstructions(). */
export const ANIMATION_INSTRUCTIONS = `
## Tool: show_math_animation
- You can display a short animated diagram on the user's screen to illustrate a math idea.
  Hand-built topics (just pass the topic, nothing else):
  - "sine": a point rotating around the unit circle tracing out the sine wave.
  - "pythagoras": squares on the sides of a right triangle, showing a² + b² = c².
  - "derivative": a tangent line sliding along the parabola y = x², showing the slope is 2x.
  - "vectors": tip-to-tail vector addition, a + b.
  These four loop continuously on their own and have no discrete steps to navigate.
- For any OTHER math idea, you can still call show_math_animation on the fly: pass a short
  slug-like \`topic\` (e.g. "fourier_series"), a \`title\` (<=80 chars), and 3-6 short \`steps\`
  (<=65 chars each) that walk through the idea in order. Required whenever topic isn't one of
  the four above. Only the first step is shown at first — see control_math_animation below for
  how the student moves through the rest.
- Call show_math_animation whenever the user asks to see, show, visualize, draw, or picture
  a math idea, or when a quick visual would clearly help your explanation.
- After calling the tool, keep speaking naturally: give a short spoken explanation (a sentence
  or two) narrating what's on screen right now. Never read out topic names, tool names, or the
  fact that you called a tool.
- Then check they actually understood it: ask one short question that makes them apply the
  specific concept just shown to a new case (e.g. after the Pythagoras animation, give a new
  triangle's two legs and ask for the hypotenuse), rather than a generic "does that make sense?"
  Wait for their answer before treating the topic as done — if they get it wrong or seem unsure,
  clarify the point and ask a simpler follow-up rather than moving on.

## Tool: control_math_animation
- Once an on-the-fly show_math_animation (one with steps) is on screen, the student paces it by
  voice instead of watching it play out unattended. Call control_math_animation with:
  - action "next" when they ask to move on ("next", "go on", "what's next", "show the next step")
  - action "previous" when they want to go back ("go back", "the step before that")
  - action "repeat" when they want the current step shown again ("show that again", "repeat
    that", "I didn't catch that")
- Has no effect on the four hand-built topics above — they have no steps, so only call this
  right after a show_math_animation that included steps.
`.trim();

/** Flue tool the model can call. It only echoes its input — the pipecat bot observes the call
 *  (via flue's `/animation/:id` endpoint) and pushes it to the browser to render. For topics
 *  outside ANIMATION_TOPICS, bot/animations.py builds a generic on-the-fly scene from
 *  title/steps instead of one of the hand-built ones. */
export const showMathAnimation = defineTool({
  name: 'show_math_animation',
  description:
    'Display an animated diagram illustrating a math concept on the user’s screen. ' +
    'Hand-built topics: sine, pythagoras, derivative, vectors. Any other topic is rendered ' +
    'on the fly from a title and a short ordered list of steps.',
  input: v.object({
    topic: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(60),
      v.description(
        'Which animation to show. One of sine, pythagoras, derivative, vectors — or a short ' +
          'slug for a new topic (then title/steps are required).',
      ),
    ),
    title: v.optional(
      v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80), v.description(
        'Short title for an on-the-fly topic (required unless topic is a hand-built one).',
      )),
    ),
    steps: v.optional(
      v.pipe(
        v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_STEP_LENGTH))),
        v.minLength(1),
        v.maxLength(MAX_STEPS),
        v.description(
          'Ordered short beats explaining an on-the-fly topic (required unless topic is a ' +
            'hand-built one), max 6.',
        ),
      ),
    ),
  }),
  output: v.object({
    topic: v.string(),
    shown: v.literal(true),
  }),
  async run({ input }) {
    if (!isRenderableAnimationInput(input.topic, input.title, input.steps)) {
      throw new Error(
        `show_math_animation: topic "${input.topic}" isn't hand-built — pass a title and ` +
          'steps to render it on the fly.',
      );
    }
    return withSpan('tool.show_math_animation', { topic: input.topic }, async () => {
      return { topic: input.topic, shown: true as const };
    });
  },
});

export const ANIMATION_CONTROL_ACTIONS = ['next', 'previous', 'repeat'] as const;

/** Applies a voice-pacing action to a step index, clamped to the step list's bounds.
 *  'repeat' (and anything else) leaves the index unchanged — app.ts still bumps the
 *  animation's revision so the client re-renders the current step. */
export function applyAnimationControl(
  current: number,
  totalSteps: number,
  action: string,
): number {
  if (action === 'next') return Math.min(current + 1, totalSteps - 1);
  if (action === 'previous') return Math.max(current - 1, 0);
  return current;
}

/** Voice-pacing control for an on-the-fly animation's steps. Like show_math_animation, it only
 *  echoes its input — app.ts's observe() applies applyAnimationControl() to the conversation's
 *  stored step index (a no-op if the current animation has no steps, e.g. a hand-built topic). */
export const controlMathAnimation = defineTool({
  name: 'control_math_animation',
  description:
    'Move to the next or previous step of the on-the-fly math animation currently on screen, ' +
    'or replay the current step. No effect on the four hand-built topics (sine, pythagoras, ' +
    'derivative, vectors), which loop continuously and have no steps.',
  input: v.object({
    action: v.picklist(ANIMATION_CONTROL_ACTIONS),
  }),
  output: v.object({ action: v.string() }),
  async run({ input }) {
    return withSpan('tool.control_math_animation', { action: input.action }, async () => {
      return { action: input.action };
    });
  },
});

/** Parses a raw show_math_animation tool-call `args` value (untyped — it comes off an
 *  `observe()` event) into the fields app.ts's observe() needs to store new state, or
 *  undefined if `topic` isn't a string (the one field required to store anything). A
 *  non-string `title` or non-array `steps` is dropped rather than rejected, and any
 *  non-string entries within `steps` are filtered out. */
export function parseShowMathAnimationArgs(
  args: unknown,
): { topic: string; title?: string; steps?: string[] } | undefined {
  const a = args as { topic?: unknown; title?: unknown; steps?: unknown } | undefined;
  const topic = a?.topic;
  if (typeof topic !== 'string') return undefined;
  const title = typeof a?.title === 'string' ? a.title : undefined;
  const steps = Array.isArray(a?.steps)
    ? a.steps.filter((s): s is string => typeof s === 'string')
    : undefined;
  return { topic, title, steps };
}

/** Parses a raw control_math_animation tool-call `args` value into its action string, or
 *  undefined if `action` isn't a string. */
export function parseControlAction(args: unknown): string | undefined {
  const a = args as { action?: unknown } | undefined;
  return typeof a?.action === 'string' ? a.action : undefined;
}

