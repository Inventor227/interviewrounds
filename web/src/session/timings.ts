// Stage timings of one round start, for the loading budget (Enter tap to the interviewer's first
// word in 4 s warm). Marks are points on the performance.now() timeline; spans are the stages
// between them. Logged to the console once the first word plays and shown in the debug overlay.

export type StageMark =
  /** The mic tap: prepare() starts. */
  | 'prepare'
  | 'session_created'
  /** The room code (the XR chunk) is loaded. */
  | 'chunk_loaded'
  /** The world and renderer exist. */
  | 'room_ready'
  /** Every panelist's avatar, clips and the lip sync model are loaded. */
  | 'avatars_loaded'
  | 'prepared'
  /** The Enter tap. */
  | 'enter'
  | 'xr_started'
  | 'placed'
  | 'voices_connected'
  | 'start_sent'
  /** The interviewer's first word plays. */
  | 'first_audio';

export interface StageSpans {
  /** Mic tap to the session from the server. */
  session_ms: number | null;
  /** Loading the room code. */
  chunk_ms: number | null;
  /** Loading the avatars (model, clips, lip sync model). */
  avatars_ms: number | null;
  /** Mic tap to ready for Enter. */
  prepare_ms: number | null;
  /** Enter tap to the XR session running. */
  xr_start_ms: number | null;
  /** XR session running to the desk placed. */
  placement_ms: number | null;
  /** Enter tap to the voices connected (runs alongside placement). */
  voice_connect_ms: number | null;
  /** The start marker to the first word. */
  first_audio_ms: number | null;
  /** Enter tap to the first word, the time placement took left out. */
  enter_to_first_word_ms: number | null;
  /** Enter tap to the first word, wall clock. */
  enter_to_first_word_wall_ms: number | null;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class StageTimings {
  private readonly marks = new Map<StageMark, number>();
  private readonly starts = new Map<string, number>();
  private readonly listeners = new Set<(s: StageSpans) => void>();
  private logged = false;

  /** Records a mark once (the first time wins, so a retried step keeps its first start). */
  mark(name: StageMark, at: number = now()): void {
    if (this.marks.has(name)) return;
    this.marks.set(name, at);
    // Also on the page's performance timeline, where measurement tools read it.
    try {
      performance.mark(`ir:${name}`, { startTime: at });
    } catch {
      // No User Timing here (tests, old browsers).
    }
    for (const l of [...this.listeners]) l(this.spans());
    if (name === 'first_audio' && !this.logged) {
      this.logged = true;
      console.info('[round] stage timings (ms)', JSON.stringify(this.spans()));
    }
  }

  /** A stage that starts and ends inside one module (the chunk, the avatars). */
  begin(stage: 'chunk' | 'avatars', at: number = now()): void {
    this.starts.set(stage, at);
  }

  at(name: StageMark): number | null {
    return this.marks.get(name) ?? null;
  }

  onChange(cb: (s: StageSpans) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  spans(): StageSpans {
    const d = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? null : Math.round(b - a));
    const m = (k: StageMark) => this.marks.get(k);
    const placement = d(m('xr_started'), m('placed'));
    const wall = d(m('enter'), m('first_audio'));
    return {
      session_ms: d(m('prepare'), m('session_created')),
      chunk_ms: d(this.starts.get('chunk'), m('chunk_loaded')),
      avatars_ms: d(this.starts.get('avatars'), m('avatars_loaded')),
      prepare_ms: d(m('prepare'), m('prepared')),
      xr_start_ms: d(m('enter'), m('xr_started')),
      placement_ms: placement,
      voice_connect_ms: d(m('enter'), m('voices_connected')),
      first_audio_ms: d(m('start_sent'), m('first_audio')),
      enter_to_first_word_ms: wall === null || placement === null ? null : wall - placement,
      enter_to_first_word_wall_ms: wall,
    };
  }
}
