// Resting faces: small ARKit morph weights per conversation mode, shifted by the persona's temperament. They are
// subtle on purpose (0.05 to 0.3): at 1 to 1.5 m a little warmth or concentration reads, more looks like acting.

import type { AvatarMode, Mood } from './types';

export type Face = Readonly<Record<string, number>>;

/** Every morph a face preset may touch; the avatar eases each of them toward the active preset. */
export const FACE_KEYS = [
  'mouthSmileLeft',
  'mouthSmileRight',
  'browInnerUp',
  'browDownLeft',
  'browDownRight',
  'browOuterUpLeft',
  'browOuterUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'cheekSquintLeft',
  'cheekSquintRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthRollLower',
  'mouthDimpleLeft',
  'mouthDimpleRight',
] as const;

const both = (l: string, r: string, v: number) => ({ [l]: v, [r]: v });
const smile = (v: number) => both('mouthSmileLeft', 'mouthSmileRight', v);
const squint = (v: number) => both('eyeSquintLeft', 'eyeSquintRight', v);
const press = (v: number) => both('mouthPressLeft', 'mouthPressRight', v);
const browDown = (v: number) => both('browDownLeft', 'browDownRight', v);

const MODES: Record<AvatarMode, Face> = {
  idle: { ...smile(0.06) },
  // Attentive and open: a hint of a smile, soft eyes, brows slightly lifted.
  listening: { ...smile(0.14), ...squint(0.1), ...both('cheekSquintLeft', 'cheekSquintRight', 0.05), browInnerUp: 0.08 },
  // Concentrating: inner brows up, lips pressed, a slight squint.
  thinking: { browInnerUp: 0.28, ...press(0.3), ...squint(0.16), mouthRollLower: 0.12, ...browDown(0.06) },
  // Neutral base; speech and beats add brow raises on top.
  speaking: { ...smile(0.07), browInnerUp: 0.04 },
};

const MOODS: Record<Mood, { smile: number; extra: Face }> = {
  warm: { smile: 1.4, extra: { ...both('mouthDimpleLeft', 'mouthDimpleRight', 0.08) } },
  neutral: { smile: 1, extra: {} },
  stern: { smile: 0.2, extra: { ...browDown(0.12), ...press(0.08) } },
};

/** Target face for a mode and mood. Values are clamped to [0, 0.6]. */
export function faceFor(mode: AvatarMode, mood: Mood): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of FACE_KEYS) out[k] = 0;
  const m = MOODS[mood];
  for (const [k, v] of Object.entries(MODES[mode])) out[k] = k.startsWith('mouthSmile') ? v * m.smile : v;
  for (const [k, v] of Object.entries(m.extra)) out[k] = (out[k] ?? 0) + v;
  for (const k in out) out[k] = Math.min(0.6, Math.max(0, out[k]!));
  return out;
}
