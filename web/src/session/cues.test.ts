import { describe, expect, it } from 'vitest';
import type { GhostOp, RoundStatePayload, ServerMsgMap, ServerMsgType } from '../shared/types';
import { createSounds } from '../xr/sound';
import { wireCues, type CueName } from './cues';

function fakeSocket() {
  const handlers = new Map<string, Set<(d: never) => void>>();
  return {
    on<T extends ServerMsgType>(t: T, cb: (d: ServerMsgMap[T]) => void) {
      let set = handlers.get(t);
      if (!set) handlers.set(t, (set = new Set()));
      set.add(cb as (d: never) => void);
      return () => set.delete(cb as (d: never) => void);
    },
    server<T extends ServerMsgType>(t: T, d: ServerMsgMap[T]) {
      for (const cb of handlers.get(t) ?? []) (cb as (d: ServerMsgMap[T]) => void)(d);
    },
    listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

const rs = (over: Partial<RoundStatePayload> = {}): RoundStatePayload => ({
  status: 'live',
  phase_id: 'a',
  phase_index: 0,
  phases: [],
  elapsed_s: 0,
  remaining_s: 100,
  phase_remaining_s: 50,
  brief: { question: '', lines: [] },
  floor: 'p1',
  time_check_due: false,
  ...over,
});
const ghost = (id: string) => ({ op_id: id, src: 'scribe', op: 'item.label', args: { id: 'n1', text: 'Cache' } }) as GhostOp;

describe('round cues', () => {
  it('suggestions_pop_once_per_batch', () => {
    const played: CueName[] = [];
    const socket = fakeSocket();
    wireCues((n) => played.push(n), socket);
    socket.server('board.ghosts', { ghosts: [ghost('g1'), ghost('g2'), ghost('g3')] });
    expect(played).toEqual(['ghost']); // three suggestions, one pop
    socket.server('board.ghosts', { ghosts: [ghost('g2'), ghost('g3')] }); // one accepted: the list shrank
    socket.server('board.ghosts', { ghosts: [] });
    expect(played).toEqual(['ghost']);
    socket.server('board.ghosts', { ghosts: [ghost('g4')] });
    expect(played).toEqual(['ghost', 'ghost']);
  });

  it('nothing_plays_while_the_round_is_paused', () => {
    const played: CueName[] = [];
    const socket = fakeSocket();
    let paused = true;
    wireCues((n) => played.push(n), socket, { paused: () => paused });
    socket.server('round.state', rs());
    socket.server('round.state', rs({ time_check_due: true }));
    socket.server('round.state', rs({ floor: 'p2' }));
    socket.server('board.ghosts', { ghosts: [ghost('g1')] });
    expect(played).toEqual([]);
    paused = false;
    socket.server('round.state', rs({ floor: 'p1' }));
    expect(played).toEqual(['handover']);
  });

  it('time_checks_and_hand_overs_play_on_their_edges', () => {
    const played: CueName[] = [];
    const socket = fakeSocket();
    const cues = wireCues((n) => played.push(n), socket);
    socket.server('round.state', rs());
    socket.server('round.state', rs());
    expect(played).toEqual([]); // the first snapshot and repeats are silent
    socket.server('round.state', rs({ time_check_due: true }));
    socket.server('round.state', rs({ time_check_due: true }));
    socket.server('round.state', rs({ floor: 'p2' }));
    socket.server('round.state', rs({ floor: 'p2', status: 'paused' }));
    socket.server('round.state', rs({ floor: 'p2', status: 'paused' }));
    socket.server('round.state', rs({ floor: 'p2' }));
    // The pause and resume tones are the controller's (they play at the press, not on the server's echo).
    expect(played).toEqual(['tick', 'handover']);
    cues.roundStarted();
    cues.roundStarted();
    expect(played.filter((p) => p === 'start')).toHaveLength(1);
    cues.dispose();
    expect(socket.listeners()).toBe(0);
  });

  it('no_cue_sounds_while_the_user_is_speaking', () => {
    // The gate lives in the sounds: with the user talking nothing starts, so nothing reaches the mic.
    let speaking = true;
    let sources = 0;
    const node = { connect: () => node, start: () => void sources++, stop: () => undefined, gain: { value: 0, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, frequency: { value: 0, setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined }, Q: { value: 0 }, type: '', buffer: null as unknown };
    const ctx = {
      state: 'running',
      currentTime: 0,
      sampleRate: 48000,
      destination: {},
      createGain: () => node,
      createOscillator: () => node,
      createBufferSource: () => node,
      createBiquadFilter: () => node,
      createBuffer: (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len), sampleRate: 48000 }),
      resume: async () => undefined,
    } as unknown as AudioContext;
    const sounds = createSounds(() => ctx, { isSpeaking: () => speaking, load: async () => new ArrayBuffer(0), decode: () => null });
    const socket = fakeSocket();
    wireCues((n) => sounds.play(n), socket);
    socket.server('board.ghosts', { ghosts: [ghost('g1')] });
    socket.server('round.state', rs());
    socket.server('round.state', rs({ time_check_due: true, floor: 'p2' }));
    expect(sources).toBe(0);
    speaking = false;
    socket.server('board.ghosts', { ghosts: [ghost('g9')] });
    expect(sources).toBeGreaterThan(0);
  });
});
