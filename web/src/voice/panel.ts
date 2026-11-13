// The panel: one voice transport per AI person, and the floor (who may hear the user).
//
// - swap (default): only the floor panelist is connected. A hand-over asks the server for the
//   new panelist's voice with the opening line, starts the new transport, then stops the old one,
//   so there is never a moment with nobody in the room.
// - joined: everyone is connected from the start; only the floor has the mic. A hand-over moves
//   the mic and sends the new floor `[event: handover]` so it speaks its prepared line.

import { api as defaultApi, type Api } from '../net/api';
import { VOICE_MARKERS, type CreateSessionRes, type Panelist } from '../shared/types';
import type { TransportOptions, VoiceTransport } from './transport';

export type MakeTransport = (p: Panelist, opts?: TransportOptions) => VoiceTransport;

export interface PanelOptions {
  api?: Pick<Api, 'joinPanelist'>;
  /**
   * Resolves once this transport's agent is not speaking (or after a short cap), so a hand-over
   * never cuts the outgoing panelist mid-sentence or overlaps two voices.
   */
  waitQuiet?: (t: VoiceTransport) => Promise<void>;
}

export class PanelController {
  private readonly transports = new Map<string, VoiceTransport>();
  private readonly panel: Map<string, Panelist>;
  private readonly api: Pick<Api, 'joinPanelist'>;
  private readonly waitQuiet: (t: VoiceTransport) => Promise<void>;
  private floorId: string;
  private muted = false;
  /** Set by stopAll(): anything still connecting is stopped as soon as it is up. */
  private stopped = false;
  /** Hand-overs run one at a time, in arrival order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly res: CreateSessionRes,
    private readonly make: MakeTransport,
    opts: PanelOptions = {},
  ) {
    this.panel = new Map(res.panel.map((p) => [p.panelist_id, p]));
    this.floorId = res.floor;
    this.api = opts.api ?? defaultApi;
    this.waitQuiet = opts.waitQuiet ?? (async () => undefined);
  }

  get floor(): string {
    return this.floorId;
  }

  get mode(): CreateSessionRes['panel_mode'] {
    return this.res.panel_mode;
  }

  /** The floor panelist's transport. */
  current(): VoiceTransport | undefined {
    return this.transports.get(this.floorId);
  }

  get(panelistId: string): VoiceTransport | undefined {
    return this.transports.get(panelistId);
  }

  all(): VoiceTransport[] {
    return [...this.transports.values()];
  }

  async start(): Promise<void> {
    const ids = this.res.panel_mode === 'joined' ? [...this.panel.keys()] : [this.floorId];
    await Promise.all(
      ids.map(async (id) => {
        const p = await this.withVoice(id);
        if (this.stopped) return;
        const t = this.make(p);
        // Only the floor may hear the user, from the first moment on.
        if (this.muted || id !== this.floorId) t.setMicMuted(true);
        this.transports.set(id, t);
        await t.start();
        if (this.stopped) await t.stop();
      }),
    );
    if (!this.stopped) void this.applyGating();
  }

  handOver(to: string, openingLine: string): Promise<void> {
    const run = this.queue.then(() => this.doHandOver(to, openingLine));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** true: nobody hears the user (pause, mute). false: the floor hears again. */
  muteAll(muted: boolean): Promise<void> {
    this.muted = muted;
    return this.applyGating();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    const ts = this.all();
    this.transports.clear();
    await Promise.allSettled(ts.map((t) => t.stop()));
  }

  // ---------- internals ----------

  private async doHandOver(to: string, openingLine: string): Promise<void> {
    if (this.stopped || to === this.floorId || !this.panel.has(to)) return;
    const oldId = this.floorId;
    const old = this.transports.get(oldId);
    // Let the outgoing panelist finish its hand-off sentence first.
    if (old) await this.waitQuiet(old);
    if (this.stopped) return;

    if (this.res.panel_mode === 'joined') {
      const next = this.transports.get(to);
      if (!next) throw new Error(`panelist ${to} is not connected`);
      this.floorId = to;
      void this.applyGating();
      next.sendEvent(VOICE_MARKERS.handover);
      return;
    }

    // Swap: the old floor stops hearing the user before the new session connects, and the new one
    // starts muted, so two sessions never transcribe the same speech.
    old?.setMicMuted(true);
    let next: VoiceTransport;
    try {
      const { voice } = await this.api.joinPanelist(this.res.session_id, to, { opening_line: openingLine });
      if (this.stopped) return;
      const p = { ...this.panel.get(to)!, voice };
      this.panel.set(to, p);
      next = this.make(p, { openingLine });
      next.setMicMuted(true);
      try {
        await next.start();
      } catch (err) {
        void next.stop().catch(() => undefined);
        throw err;
      }
    } catch (err) {
      if (!this.stopped) void this.applyGating(); // the old floor hears again
      throw err;
    }
    if (this.stopped) {
      await next.stop();
      return;
    }
    if (old) this.transports.delete(oldId);
    this.transports.set(to, next);
    this.floorId = to;
    void this.applyGating(); // unmutes the new floor
    if (old) await old.stop();
  }

  /** Joined mode connects everyone, so a panelist whose voice is still pending joins now. */
  private async withVoice(id: string): Promise<Panelist> {
    const p = this.panel.get(id);
    if (!p) throw new Error(`unknown panelist ${id}`);
    if (p.voice.transport !== 'fish_pending') return p;
    const { voice } = await this.api.joinPanelist(this.res.session_id, id, {});
    const ready = { ...p, voice };
    this.panel.set(id, ready);
    return ready;
  }

  /** Resolves once every transport has applied its gate. */
  private applyGating(): Promise<void> {
    const done: (void | Promise<void>)[] = [];
    for (const [id, t] of this.transports) done.push(t.setMicMuted(this.muted || id !== this.floorId));
    return Promise.all(done).then(() => undefined);
  }
}
