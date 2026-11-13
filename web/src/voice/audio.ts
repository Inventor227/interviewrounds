// One AudioContext for the whole page: resumed in the Start click, shared by lip sync analysers.
// Nothing connects agent audio to its destination (echo cancellation needs the <audio> element).

let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext | null {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

export async function resumeAudio(): Promise<void> {
  const c = getAudioContext();
  if (c && c.state === 'suspended') await c.resume();
}
