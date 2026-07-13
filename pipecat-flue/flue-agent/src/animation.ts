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

function isCanonicalTopic(topic: string): topic is AnimationTopic {
  return (ANIMATION_TOPICS as readonly string[]).includes(topic);
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
- For any OTHER math idea, you can still call show_math_animation on the fly: pass a short
  slug-like \`topic\` (e.g. "fourier_series"), a \`title\` (<=80 chars), and 3-6 short \`steps\`
  (<=65 chars each) that walk through the idea in order — these render as a sequential
  reveal in the same visual style. Required whenever topic isn't one of the four above.
- Call show_math_animation whenever the user asks to see, show, visualize, draw, or picture
  a math idea, or when a quick visual would clearly help your explanation.
- The animation plays on its own on screen. After calling the tool, keep speaking naturally:
  give a short spoken explanation (a sentence or two) narrating what the animation shows.
  Never read out topic names, tool names, or the fact that you called a tool.
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
    if (!isCanonicalTopic(input.topic) && (!input.title || !input.steps?.length)) {
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
