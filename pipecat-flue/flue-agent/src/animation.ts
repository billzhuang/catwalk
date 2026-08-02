import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { withSpan } from './telemetry.ts';

/** Canonical animation topics with a hand-built scene (bot/animations.py SCENES). Any other
 *  topic is rendered on the fly from the `title`/`steps` the model supplies (see below). */
export const ANIMATION_TOPICS = ['sine', 'pythagoras', 'derivative', 'vectors'] as const;
export type AnimationTopic = (typeof ANIMATION_TOPICS)[number];

/** Tool names flue dispatches on, shared with app.ts's handleFlueEvent so the tool
 *  definitions below and the dispatcher matching their calls can't drift apart under a
 *  future rename — a mismatch wouldn't error, it would just silently stop tracking
 *  animation state. */
export const SHOW_MATH_ANIMATION_TOOL = 'show_math_animation';
export const CONTROL_MATH_ANIMATION_TOOL = 'control_math_animation';

const MAX_STEPS = 6;
// SVG <text> doesn't auto-wrap; at the generic scene's 18px font size a step much longer
// than this would overflow the 650px-wide viewport and get clipped (bot/animations.py
// MAX_GENERIC_STEP mirrors this).
const MAX_STEP_LENGTH = 65;
const MAX_TITLE_LENGTH = 80;
const MAX_TOPIC_LENGTH = 60;

// Single source of truth for each field's bounds, shared by showMathAnimation's own input
// schema below and isRenderableAnimationInput's pre-check — the exact two places that
// previously drifted apart (fix: bounds-check title/steps on an ALIASES synonym in
// isRenderableAnimationInput; fix: reject an out-of-bounds on-the-fly topic in
// isRenderableAnimationInput), since isRenderableAnimationInput re-derived these same
// trim/length rules by hand instead of asking the schema.
const topicSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(MAX_TOPIC_LENGTH),
  v.description(
    'Which animation to show. One of sine, pythagoras, derivative, vectors — or a short ' +
      'slug for a new topic (then title/steps are required).',
  ),
);
const titleSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(MAX_TITLE_LENGTH),
  v.description('Short title for an on-the-fly topic (required unless topic is a hand-built one).'),
);
const stepSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_STEP_LENGTH));
const stepsSchema = v.pipe(
  v.array(stepSchema),
  v.minLength(1),
  v.maxLength(MAX_STEPS),
  v.description(
    'Ordered short beats explaining an on-the-fly topic (required unless topic is a ' +
      'hand-built one), max 6.',
  ),
);

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

// ANIMATION_ALIASES is a plain object literal, so a bare `normalized in ANIMATION_ALIASES` or
// `ANIMATION_ALIASES[normalized]` also matches inherited Object.prototype keys (e.g.
// "constructor", "valueOf", "isPrototypeOf") — a topic string of "constructor" would then
// wrongly read out the Object constructor function instead of finding no alias. Shared by
// isCanonicalTopic and resolveCanonicalTopic so both restrict lookups to the map's own keys.
function getAlias(normalized: string): AnimationTopic | undefined {
  return Object.prototype.hasOwnProperty.call(ANIMATION_ALIASES, normalized)
    ? ANIMATION_ALIASES[normalized]
    : undefined;
}

// Shared by isCanonicalTopic, isExactCanonicalTopic, and resolveCanonicalTopic, which each used
// to re-derive this same `(ANIMATION_TOPICS as readonly string[]).includes(...)` cast+lookup.
function isAnimationTopic(normalized: string): normalized is AnimationTopic {
  return (ANIMATION_TOPICS as readonly string[]).includes(normalized);
}

// Defers to resolveCanonicalTopic (below) rather than re-deriving the same
// normalize+isAnimationTopic+getAlias chain, so the two can't drift apart.
function isCanonicalTopic(topic: string): boolean {
  return resolveCanonicalTopic(topic) !== undefined;
}

/** True only for an exact ANIMATION_TOPICS match (modulo case/whitespace/dash) — NOT an
 *  ANIMATION_ALIASES synonym. Mirrors bot/animations.py's render(): an exact match always uses
 *  its hand-built builder regardless of title/steps, but an alias match (e.g. "triangle") only
 *  falls back to the hand-built scene when title/steps are absent — if both are supplied, the
 *  caller's on-the-fly content wins over the loose synonym match. Callers deciding whether to
 *  discard title/steps before storing state must use this, not isCanonicalTopic, or an alias
 *  collision with genuine on-the-fly content (e.g. topic "triangle" with its own title/steps
 *  about a different idea) would lose that content and get silently misrendered instead. */
export function isExactCanonicalTopic(topic: string): boolean {
  return isAnimationTopic(normalizeExactTopic(topic));
}

/** Resolves an exact canonical topic or an ANIMATION_ALIASES synonym (e.g. "triangle") to the
 *  ANIMATION_TOPICS name of the hand-built scene it actually renders, or undefined if `topic`
 *  isn't canonical at all. Mirrors bot/animations.py's `_normalize()`. Callers storing state for
 *  a call that will render a hand-built scene must store this, not the caller's raw topic
 *  string — otherwise the client's title fallback (`topic.replace(/_/g, " ")` when no title was
 *  given) displays the model's incidental synonym (e.g. "triangle") over a scene it doesn't
 *  name (pythagoras), instead of the scene actually on screen. */
export function resolveCanonicalTopic(topic: string): AnimationTopic | undefined {
  const normalized = normalizeExactTopic(topic);
  if (isAnimationTopic(normalized)) return normalized;
  return getAlias(normalized);
}

/** True when a title and at least one step are both present — the "does this call carry real
 *  on-the-fly content" check shared by isRenderableAnimationInput below and app.ts's
 *  usesGenericScene, which both used to re-derive it independently (a documented drift risk:
 *  each side's comment pointed at the other as computing "this same condition"). Only meaningful
 *  once title/steps have already passed titleSchema/stepsSchema (as both call sites ensure),
 *  since only then does a defined title imply non-blank-after-trim. */
export function hasGenericContent(title?: string, steps?: string[]): boolean {
  return !!title?.trim() && !!steps?.length;
}

/** True if show_math_animation's args are enough to actually render something: an exact
 *  canonical topic (title/steps ignored), or — for anything else, including an ALIASES synonym
 *  like "triangle" — a title and at least one step, all within the tool's own valibot bounds
 *  (MAX_TOPIC_LENGTH/MAX_TITLE_LENGTH/MAX_STEPS/MAX_STEP_LENGTH); a synonym with no title/steps
 *  still renders via its hand-built fallback. Shared by the tool's own run() (which throws on false) and
 *  app.ts's observe() handler (which silently skips storing state on false) so the two can't
 *  drift apart — storing state that can't render leaves the browser polling a topic
 *  bot/animations.py's render() will 404 on. `topic`/`title`/`steps` are checked post-trim,
 *  matching the schema's own v.trim(): observe()'s raw event args haven't gone through that
 *  schema, so a whitespace-only or over-length topic, title, or step would otherwise look
 *  renderable here and then fail that schema validation in run() — the exact bug this function
 *  exists to prevent, just one layer deeper. Whichever of title/steps is supplied is bounds-
 *  checked unconditionally: the schema validates each independently whenever present, so e.g. an
 *  alias topic with an oversized `steps` array but no `title` still fails validation even though
 *  render()'s `if title and steps` would have alias-fallen-back had it gotten that far. */
export function isRenderableAnimationInput(topic: string, title?: string, steps?: string[]): boolean {
  if (isExactCanonicalTopic(topic)) return true;
  if (title !== undefined && !v.safeParse(titleSchema, title).success) return false;
  if (steps !== undefined && !v.safeParse(stepsSchema, steps).success) return false;
  // Mirrors render()'s precedence: only when both title and steps are present does the caller's
  // on-the-fly content take over from an ALIASES synonym like "triangle" — otherwise (including a
  // lone, in-bounds title or steps with nothing paired) it falls back to isCanonicalTopic, same
  // as no content at all.
  if (!hasGenericContent(title, steps)) return isCanonicalTopic(topic);
  return v.safeParse(topicSchema, topic).success;
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
  name: SHOW_MATH_ANIMATION_TOOL,
  description:
    'Display an animated diagram illustrating a math concept on the user’s screen. ' +
    'Hand-built topics: sine, pythagoras, derivative, vectors. Any other topic is rendered ' +
    'on the fly from a title and a short ordered list of steps.',
  input: v.object({
    topic: topicSchema,
    title: v.optional(titleSchema),
    steps: v.optional(stepsSchema),
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

const ANIMATION_CONTROL_ACTIONS = ['next', 'previous', 'repeat'] as const;

/** Applies a voice-pacing action to a step index, clamped to the step list's bounds.
 *  'repeat' leaves the index unchanged — app.ts still bumps the animation's revision so
 *  the client re-renders the current step. parseControlAction below guarantees `action`
 *  is always one of ANIMATION_CONTROL_ACTIONS by the time it reaches here. */
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
  name: CONTROL_MATH_ANIMATION_TOOL,
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

/** Reads `key` off an untyped tool-call `args` object, returning it only if it's a string —
 *  shared by parseShowMathAnimationArgs's `title` and parseControlAction's `action`, which both
 *  otherwise duplicate this same "field is a string, else undefined" cast. */
function getStringField(a: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = a?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Parses a raw show_math_animation tool-call `args` value (untyped — it comes off an
 *  `observe()` event) into the fields app.ts's observe() needs to store new state, or
 *  undefined if `topic` isn't a string (the one field required to store anything). A
 *  non-string `title` or non-array `steps` is dropped rather than rejected, and any
 *  non-string entries within `steps` are filtered out. topic/title/each step are trimmed
 *  to match topicSchema/titleSchema/stepSchema's own v.trim() — isRenderableAnimationInput
 *  validates these fields post-trim (via v.safeParse), but safeParse only reports pass/fail
 *  and discards its trimmed output, so without trimming here too, a whitespace-padded value
 *  that safely passes validation would still get stored and served untrimmed. */
export function parseShowMathAnimationArgs(
  args: unknown,
): { topic: string; title?: string; steps?: string[] } | undefined {
  const a = args as { topic?: unknown; title?: unknown; steps?: unknown } | undefined;
  const topic = a?.topic;
  if (typeof topic !== 'string') return undefined;
  const title = getStringField(a, 'title')?.trim();
  const steps = Array.isArray(a?.steps)
    ? a.steps.filter((s): s is string => typeof s === 'string').map((s) => s.trim())
    : undefined;
  return { topic: topic.trim(), title, steps };
}

/** Parses a raw control_math_animation tool-call `args` value into its action string, or
 *  undefined if `action` isn't a string or isn't one of ANIMATION_CONTROL_ACTIONS. Mirrors
 *  the tool's own `v.picklist(ANIMATION_CONTROL_ACTIONS)` schema: observe()'s raw event args
 *  haven't gone through that schema (see isRenderableAnimationInput's doc comment above), so
 *  without this check here too, an out-of-picklist action (a typo or model drift) would look
 *  valid to app.ts's handleControlMathAnimation and bump the conversation's animation revision
 *  — triggering a spurious client re-render — for a tool call that run()'s real schema
 *  validation would have rejected outright. */
export function parseControlAction(args: unknown): (typeof ANIMATION_CONTROL_ACTIONS)[number] | undefined {
  const action = getStringField(args as Record<string, unknown> | undefined, 'action');
  return action !== undefined && (ANIMATION_CONTROL_ACTIONS as readonly string[]).includes(action)
    ? (action as (typeof ANIMATION_CONTROL_ACTIONS)[number])
    : undefined;
}

