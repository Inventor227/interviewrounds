import { describe, expect, it } from 'vitest';
import { createSounds, type SoundName } from './sound';

describe('createSounds', () => {
  it('plays_every_board_and_ui_sound_by_name_without_audio', () => {
    // No AudioContext (tests, muted pages): every sound is a quiet no-op, never an error.
    const s = createSounds(() => null);
    for (const n of ['click', 'flap', 'chime', 'snap', 'pen', 'erase'] as SoundName[]) expect(() => s.play(n)).not.toThrow();
  });
});
