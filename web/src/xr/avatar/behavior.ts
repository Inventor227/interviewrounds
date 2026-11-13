// Conversational body language that sits on top of the clips:
// - Nodder: a slow procedural head nod (dip 3 to 6° and back over about 0.7 s), optionally doubled.
// - ListenCues: decides when a listener acknowledges: at the user's pauses (600 ms of silence after at least a second
//   of speech), at most once per pause and not more often than every 2.5 s. Without any user-speech signal it nods
//   every 5 to 9 s so a listener never freezes.
// - Beats: small beat gestures while speaking, timed to loudness onsets (stressed syllables) and phrase starts:
//   a head bob, a brow flash, a bounce of the clasped hands or a single-hand lift.

import { DEG } from './gaze';
import { between, type Rng } from './rng';

export class Nodder {
  private t = -1;
  private dur = 0.7;
  private amp = 0;
  private double = false;

  get busy(): boolean {
    return this.t >= 0;
  }

  /** Starts a nod of `amp` radians over `seconds`; a double nod adds a smaller second dip. */
  trigger(amp = 4.5 * DEG, seconds = 0.7, double = false): void {
    this.t = 0;
    this.amp = amp;
    this.dur = double ? seconds * 1.5 : seconds;
    this.double = double;
  }

  /** Head pitch offset in radians (negative = chin down). */
  update(dt: number): number {
    if (this.t < 0) return 0;
    this.t += dt;
    if (this.t >= this.dur) {
      this.t = -1;
      return 0;
    }
    const u = this.t / this.dur;
    if (!this.double) return -this.amp * Math.sin(Math.PI * u) ** 1.5;
    // Two dips: the first two thirds full size, the last third at 60 %.
    if (u < 2 / 3) return -this.amp * Math.sin(Math.PI * u * 1.5) ** 1.5;
    return -0.6 * this.amp * Math.sin(Math.PI * (u - 2 / 3) * 3) ** 1.5;
  }
}

export type ListenCue = 'nod' | 'accept' | null;

const PAUSE_S = 0.6;
const MIN_SPEECH_S = 1;
const MIN_GAP_S = 2.5;
const ACCEPT_GAP_S = 10;

export class ListenCues {
  private heard = false;
  private speaking = false;
  private speechS = 0;
  private pauseS = 0;
  private sinceCue = Infinity;
  private sinceAccept = Infinity;
  private autoWait: number;

  constructor(private readonly rng: Rng) {
    this.autoWait = between(rng, 5, 9);
  }

  /** Feed the user's voice activity (from a mic VAD or the transport), every frame or on change. */
  userSpeech(active: boolean): void {
    this.heard = true;
    this.speaking = active;
  }

  /** Returns a cue on the frame the listener should acknowledge, else null. */
  update(dt: number, listening: boolean): ListenCue {
    this.sinceCue += dt;
    this.sinceAccept += dt;
    if (this.speaking) {
      this.speechS += dt;
      this.pauseS = 0;
    } else {
      this.pauseS += dt;
    }
    if (!listening) {
      this.speechS = 0;
      return null;
    }
    if (!this.heard) {
      this.autoWait -= dt;
      if (this.autoWait > 0) return null;
      this.autoWait = between(this.rng, 5, 9);
      return this.fire();
    }
    if (!this.speaking && this.pauseS >= PAUSE_S && this.speechS >= MIN_SPEECH_S && this.sinceCue >= MIN_GAP_S) {
      this.speechS = 0;
      return this.fire();
    }
    return null;
  }

  private fire(): ListenCue {
    this.sinceCue = 0;
    if (this.sinceAccept >= ACCEPT_GAP_S && this.rng() < 0.25) {
      this.sinceAccept = 0;
      return 'accept';
    }
    return 'nod';
  }
}

export interface BeatOut {
  /** Head pitch offset, radians. */
  head: number;
  /** Brow raise 0..1. */
  brow: number;
  /** Clasped-hands bounce 0..1. */
  arms: number;
  /** Single right-hand lift 0..1. */
  armR: number;
  /** A beat started this frame. */
  beat: boolean;
  /** Voice came back after a pause this frame (a new phrase). */
  phraseStart: boolean;
}

class Envelope {
  private t = -1;
  private amp = 0;
  constructor(
    private readonly rise: number,
    private readonly fall: number,
  ) {}
  fire(amp: number): void {
    this.t = 0;
    this.amp = amp;
  }
  update(dt: number): number {
    if (this.t < 0) return 0;
    this.t += dt;
    if (this.t < this.rise) return this.amp * Math.sin((this.t / this.rise) * (Math.PI / 2));
    const u = (this.t - this.rise) / this.fall;
    if (u >= 1) {
      this.t = -1;
      return 0;
    }
    return this.amp * 0.5 * (1 + Math.cos(Math.PI * u));
  }
}

const ONSET_JUMP = 0.25;
const BEAT_GAP_S = 0.45;
const ARM_GAP_S = 1.2;
const QUIET_LEVEL = 0.1;
const PHRASE_PAUSE_S = 0.35;

export class Beats {
  private slow = 0;
  private prev = 0;
  private quietS = Infinity;
  private sinceBeat = Infinity;
  private sinceArm = Infinity;
  private headSign = 1;
  private readonly headEnv = new Envelope(0.12, 0.3);
  private readonly browEnv = new Envelope(0.1, 0.35);
  private readonly armsEnv = new Envelope(0.18, 0.4);
  private readonly armREnv = new Envelope(0.22, 0.5);
  private readonly out: BeatOut = { head: 0, brow: 0, arms: 0, armR: 0, beat: false, phraseStart: false };

  constructor(private readonly rng: Rng) {}

  /** `level` is the voice loudness 0..1; `speaking` gates everything. */
  update(dt: number, level: number, speaking: boolean): BeatOut {
    const o = this.out;
    o.beat = o.phraseStart = false;
    this.sinceBeat += dt;
    this.sinceArm += dt;
    if (speaking) {
      const rising = level - this.prev > 0.2;
      if (level < QUIET_LEVEL) this.quietS += dt;
      else {
        if (this.quietS >= PHRASE_PAUSE_S) {
          o.phraseStart = true;
          this.fire(true);
        } else if (rising && level - this.slow > ONSET_JUMP && this.sinceBeat >= BEAT_GAP_S && this.rng() < 0.6) {
          this.fire(false);
        }
        this.quietS = 0;
      }
      this.slow += (level - this.slow) * (1 - Math.exp(-dt / 0.6));
    } else {
      this.quietS = Infinity;
      this.slow = 0;
    }
    this.prev = level;
    o.head = this.headEnv.update(dt);
    o.brow = this.browEnv.update(dt);
    o.arms = this.armsEnv.update(dt);
    o.armR = this.armREnv.update(dt);
    return o;
  }

  private fire(phrase: boolean): void {
    this.out.beat = true;
    this.sinceBeat = 0;
    // Head: mostly a small chin dip on the stress, sometimes a lift.
    this.headSign = this.rng() < 0.7 ? -1 : 1;
    this.headEnv.fire(this.headSign * between(this.rng, 1.5, 3) * DEG);
    if (phrase || this.rng() < 0.45) this.browEnv.fire(between(this.rng, 0.2, 0.4));
    if (this.sinceArm >= ARM_GAP_S && (phrase ? this.rng() < 0.7 : this.rng() < 0.35)) {
      this.sinceArm = 0;
      if (this.rng() < 0.7) this.armsEnv.fire(between(this.rng, 0.5, 1));
      else this.armREnv.fire(between(this.rng, 0.6, 1));
    }
  }
}
