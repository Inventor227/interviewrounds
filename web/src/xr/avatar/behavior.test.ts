import { describe, expect, it } from 'vitest';
import { Beats, ListenCues, Nodder } from './behavior';
import { DEG } from './gaze';
import { seededRng } from './rng';

const DT = 1 / 60;

describe('behavior', () => {
  it('nod_is_a_slow_dip_and_back', () => {
    const n = new Nodder();
    n.trigger(5 * DEG, 0.7);
    let min = 0;
    let t = 0;
    while (n.busy) {
      min = Math.min(min, n.update(DT));
      t += DT;
    }
    expect(min).toBeLessThan(-4.5 * DEG);
    expect(min).toBeGreaterThanOrEqual(-5 * DEG - 1e-9);
    expect(t).toBeGreaterThan(0.65);
    expect(t).toBeLessThan(0.8);
    expect(n.update(DT)).toBe(0);
  });

  it('listening_nods_at_user_pauses_not_while_they_talk', () => {
    const c = new ListenCues(seededRng(1));
    let cues = 0;
    // The user talks for 3 s: no cue.
    for (let i = 0; i < 180; i++) {
      c.userSpeech(true);
      if (c.update(DT, true)) cues++;
    }
    expect(cues).toBe(0);
    // They pause: a cue between 0.6 and 1.0 s into the pause.
    let at = -1;
    for (let i = 0; i < 120; i++) {
      c.userSpeech(false);
      if (c.update(DT, true) && at < 0) at = i * DT;
    }
    expect(at).toBeGreaterThanOrEqual(0.55);
    expect(at).toBeLessThanOrEqual(1.0);
    // A long silence after that brings no further nods (only one per pause).
    let more = 0;
    for (let i = 0; i < 600; i++) {
      c.userSpeech(false);
      if (c.update(DT, true)) more++;
    }
    expect(more).toBe(0);
  });

  it('listening_cues_need_listening_mode', () => {
    const c = new ListenCues(seededRng(2));
    let cues = 0;
    for (let i = 0; i < 180; i++) {
      c.userSpeech(i < 120);
      if (c.update(DT, false)) cues++;
    }
    expect(cues).toBe(0);
  });

  it('listening_nods_on_its_own_without_a_user_signal', () => {
    const c = new ListenCues(seededRng(3));
    let cues = 0;
    for (let i = 0; i < 60 * 30; i++) if (c.update(DT, true)) cues++;
    // About one every 5 to 9 s.
    expect(cues).toBeGreaterThanOrEqual(3);
    expect(cues).toBeLessThanOrEqual(6);
  });

  it('beats_follow_voice_onsets_and_rest_in_silence', () => {
    const b = new Beats(seededRng(4));
    let active = 0;
    for (let i = 0; i < 120; i++) {
      const o = b.update(DT, 0, false);
      if (o.head !== 0 || o.arms !== 0 || o.brow !== 0) active++;
    }
    expect(active).toBe(0);
    // Syllable-like loudness: 4 Hz bursts for 4 s.
    let beats = 0;
    let phrase = 0;
    for (let i = 0; i < 240; i++) {
      const t = i * DT;
      const level = (t % 0.25) < 0.12 ? 0.9 : 0.15;
      const o = b.update(DT, level, true);
      if (o.beat) beats++;
      if (o.phraseStart) phrase++;
    }
    expect(phrase).toBe(1);
    // Not on every syllable: at most about one per 0.45 s.
    expect(beats).toBeGreaterThanOrEqual(3);
    expect(beats).toBeLessThanOrEqual(9);
  });
});
