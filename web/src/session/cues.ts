// Round cues: short recorded sounds for what the room does by itself. The start chime when the
// round begins (the desk is down), a tick when a time check falls due, a pop when suggestions
// arrive (once per batch) and a soft whoosh when the floor moves to another panelist. The pause
// and resume tones are played by the round controller, at the press itself (XRPort.cue). While the
// round is paused nothing here plays. The sounds themselves stay silent while the user is speaking
// (createSounds' isSpeaking gate), so none of them reaches the microphone.

import type { ServerMsgMap, ServerMsgType } from '../shared/types';

export type CueName = 'start' | 'tick' | 'ghost' | 'handover' | 'pause' | 'resume';

export interface CueSocket {
  on<T extends ServerMsgType>(t: T, cb: (d: ServerMsgMap[T]) => void): () => void;
}

export interface Cues {
  /** The round begins: call once the desk is placed. Plays once per round. */
  roundStarted(): void;
  dispose(): void;
}

export function wireCues(playCue: (name: CueName) => void, socket: CueSocket, opts: { paused?: () => boolean } = {}): Cues {
  let started = false;
  let floor: string | null = null;
  let due = false;
  const play = (name: CueName) => {
    if (!opts.paused?.()) playCue(name);
  };
  /** Suggestions already announced, so a list that only shrinks or repeats stays quiet. */
  const seen = new Set<string>();
  const offs = [
    socket.on('round.state', (d) => {
      if (d.time_check_due && !due) play('tick');
      due = !!d.time_check_due;
      if (floor !== null && d.floor && d.floor !== floor) play('handover');
      if (d.floor) floor = d.floor;
    }),
    socket.on('board.ghosts', (d) => {
      let fresh = false;
      for (const g of d.ghosts) {
        if (!seen.has(g.op_id)) fresh = true;
        seen.add(g.op_id);
      }
      if (fresh) play('ghost'); // one pop per batch, however many suggestions it holds
    }),
  ];
  return {
    roundStarted() {
      if (started) return;
      started = true;
      play('start');
    },
    dispose() {
      for (const off of offs.splice(0)) off();
    },
  };
}
