import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { withSpan } from './telemetry.ts';

/** Canonical animation topics the bot knows how to render (bot/animations.py SCENES). */
export const ANIMATION_TOPICS = ['sine', 'pythagoras', 'derivative', 'vectors'] as const;
export type AnimationTopic = (typeof ANIMATION_TOPICS)[number];

/** Instruction section for this tool — composed into the agent prompt by buildInstructions(). */
export const ANIMATION_INSTRUCTIONS = `
## Tool: show_math_animation
- You can display a short animated diagram on the user's screen to illustrate a math idea.
  Supported topics:
  - "sine": a point rotating around the unit circle tracing out the sine wave.
  - "pythagoras": squares on the sides of a right triangle, showing a² + b² = c².
  - "derivative": a tangent line sliding along the parabola y = x², showing the slope is 2x.
  - "vectors": tip-to-tail vector addition, a + b.
- Call show_math_animation whenever the user asks to see, show, visualize, draw, or picture
  one of these ideas, or when a quick visual would clearly help your explanation.
- Pick the single closest topic. If the user's math question isn't close to any supported
  topic, do NOT call the tool — just answer in words.
- The animation plays on its own on screen. After calling the tool, keep speaking naturally:
  give a short spoken explanation (a sentence or two) narrating what the animation shows.
  Never read out topic names, tool names, or the fact that you called a tool.
`.trim();

/** Flue tool the model can call. It only echoes the chosen topic — the pipecat bot observes
 *  the call (via flue's `/animation/:id` endpoint) and pushes it to the browser to render. */
export const showMathAnimation = defineTool({
  name: 'show_math_animation',
  description:
    'Display an animated diagram illustrating a math concept on the user’s screen. ' +
    'Topics: sine, pythagoras, derivative, vectors.',
  input: v.object({
    topic: v.pipe(
      v.picklist(ANIMATION_TOPICS),
      v.description('Which animation to show: sine, pythagoras, derivative, or vectors'),
    ),
  }),
  output: v.object({
    topic: v.string(),
    shown: v.literal(true),
  }),
  async run({ input }) {
    return withSpan('tool.show_math_animation', { topic: input.topic }, async () => {
      return { topic: input.topic, shown: true as const };
    });
  },
});
