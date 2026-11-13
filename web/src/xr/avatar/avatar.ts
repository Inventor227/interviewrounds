// One interviewer: a converted Rocketbox avatar with seated clips, gaze, blinks, nods, beat gestures and lip sync.
//
//   const a = await Avatar.load(entry, { renderer });   // entry from /avatars/manifest.json
//   scene.add(a.root); a.place(seat);
//   a.setMode('listening'); a.lookAt(userHeadWorld);      // every frame for lookAt
//   await a.attachVoice(remoteStream);                     // analysis only; playback stays on the <audio> element
//   a.update(dt);                                          // every frame, dt in seconds
//
// Per frame: one AnimationMixer (crossfades of 0.3 to 0.5 s between base clips), then procedural head, eyes and
// arms on top, then morph weights, written only where they changed. UI cues: isSpeaking and voiceLevel (0..1).

import {
  AudioContext as ThreeAudioContext,
  AnimationMixer,
  Group,
  LoopOnce,
  LoopRepeat,
  Mesh,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Material,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { Beats, ListenCues, Nodder } from './behavior';
import { Blinker } from './blink';
import { DEG, GazeController, anglesTo, dirFromAngles, gazeTarget, type Angles } from './gaze';
import { LipSync, type LipSyncEngine } from './lipsync';
import { configureAvatarLoader, loadAvatarGltf, loadClips } from './loader';
import { FACE_KEYS, faceFor } from './moods';
import { Rig } from './rig';
import { approach, between, seededRng, type Rng } from './rng';
import { CLIPS, type AvatarManifestEntry, type AvatarMode, type Mood, type SeatPose } from './types';

/** Table height the seated clips were made for: with the root on the floor, the hands rest at this height. */
export const CLIP_DESK_Y = 0.74;

const FADE_S = 0.45;
const ONESHOT_FADE_S = 0.35;
const FACE_TAU_S = 0.25;
const TILT_TAU_S = 0.8;
const POINT_IN_S = 0.45;
const POINT_OUT_S = 0.55;
const THINK_CLIP_AFTER_S = 2.5;
/** Clasped-hands bounce and single-hand lift at full beat strength. */
const ARMS_LIFT = 5 * DEG;
const ARM_R_LIFT = 11 * DEG;

export interface AvatarOptions {
  /** Needed on the first load: KTX2 textures pick their GPU format from the renderer. */
  renderer?: WebGLRenderer;
  mood?: Mood;
  /** Seed for this avatar's random timing (blinks, saccades); defaults to random. */
  seed?: number;
  /** Extra height for the root on top of deskY - CLIP_DESK_Y (metres). */
  yOffset?: number;
}

export interface AvatarStats {
  /** CPU time of the last update(), ms. */
  lastMs: number;
  /** Mean and max over the last 120 updates, ms. */
  meanMs: number;
  maxMs: number;
  /** Morph influences written in the last update. */
  morphWrites: number;
}

/** Morph weights shared by every primitive of the avatar, written only when they change. */
class Morphs {
  readonly target: Float32Array;
  private readonly influences: number[];
  readonly index: Record<string, number>;
  writes = 0;

  constructor(model: Object3D) {
    const meshes: Mesh[] = [];
    model.traverse((o) => {
      if (o instanceof Mesh && o.morphTargetInfluences && o.morphTargetDictionary) meshes.push(o);
    });
    const first = meshes[0];
    if (!first?.morphTargetInfluences || !first.morphTargetDictionary) throw new Error('avatar has no morph targets');
    this.influences = first.morphTargetInfluences;
    this.index = first.morphTargetDictionary;
    // One array for all primitives (body, head, hair): same targets in the same order.
    for (const m of meshes) {
      if (m === first) continue;
      const d = m.morphTargetDictionary!;
      const same = Object.keys(this.index).every((k) => d[k] === this.index[k]);
      if (same && m.morphTargetInfluences!.length === this.influences.length) m.morphTargetInfluences = this.influences;
    }
    this.target = new Float32Array(this.influences.length);
  }

  clear(): void {
    this.target.fill(0);
  }

  add(name: string, v: number): void {
    const i = this.index[name];
    if (i !== undefined) this.target[i] = this.target[i]! + v;
  }

  setMax(name: string, v: number): void {
    const i = this.index[name];
    if (i !== undefined && v > this.target[i]!) this.target[i] = v;
  }

  flush(): void {
    let n = 0;
    const inf = this.influences;
    const t = this.target;
    for (let i = 0; i < t.length; i++) {
      const v = t[i]! > 1 ? 1 : t[i]!;
      if (Math.abs(v - inf[i]!) > 1e-3 || (v === 0 && inf[i] !== 0)) {
        inf[i] = v;
        n++;
      }
    }
    this.writes = n;
  }
}

export class Avatar {
  /** Add this to the scene. Its origin is the avatar root (between the feet, on its floor); it faces +Z. */
  readonly root = new Group();
  readonly entry: AvatarManifestEntry;
  readonly stats: AvatarStats = { lastMs: 0, meanMs: 0, maxMs: 0, morphWrites: 0 };

  private _mode: AvatarMode = 'idle';
  private mood: Mood;
  private readonly rng: Rng;
  private readonly model: Object3D;
  private readonly rig: Rig;
  private readonly morphs: Morphs;
  private readonly mixer: AnimationMixer;
  private readonly clips = new Map<string, AnimationClip>();
  private readonly actions = new Map<string, AnimationAction>();
  private base: AnimationAction | null = null;
  private oneShot: AnimationAction | null = null;
  private baseWait = 0;

  private readonly gaze: GazeController;
  private readonly blinker: Blinker;
  private readonly nodder = new Nodder();
  private readonly cues: ListenCues;
  private readonly beats: Beats;
  private readonly lip: LipSync;
  private userVoice: LipSync | null = null;

  private readonly face: Record<string, number> = {};
  private faceTarget: Record<string, number>;
  private tilt = 0;
  private tiltTarget = 0;
  private time = 0;
  private modeTime = 0;
  private readonly yOffset: number;

  private lookWorld: Vector3 | null = null;
  private pointWorld = new Vector3();
  private pointLeft = 0;
  private pointT = 0;
  private pointW = 0;
  private pointSide: 'L' | 'R' = 'R';
  private readonly samples = new Float32Array(120);
  private sampleN = 0;

  // scratch
  private readonly vTarget = new Vector3();
  private readonly vAim = new Vector3();
  private readonly vWorld = new Vector3();
  private readonly aTrue: Angles = { yaw: 0, pitch: 0 };
  private readonly aHead: Angles = { yaw: 0, pitch: 0 };

  private constructor(entry: AvatarManifestEntry, model: Object3D, clips: AnimationClip[], opts: AvatarOptions) {
    this.entry = entry;
    this.model = model;
    this.mood = opts.mood ?? 'neutral';
    this.yOffset = opts.yOffset ?? 0;
    this.rng = seededRng(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.root.name = `avatar-${entry.id}`;
    this.root.add(model);
    model.traverse((o) => {
      // Skinned bounds come from the bind pose; seated poses can leave them, so never cull.
      o.frustumCulled = false;
    });
    this.rig = new Rig(this.root, model, entry);
    this.morphs = new Morphs(model);
    this.mixer = new AnimationMixer(model);
    for (const c of clips) this.clips.set(c.name, c);
    this.gaze = new GazeController(this.rng);
    this.blinker = new Blinker(this.rng);
    this.cues = new ListenCues(this.rng);
    this.beats = new Beats(this.rng);
    this.lip = new LipSync({ speakerHz: entry.sex === 'f' ? 210 : 120 });
    this.faceTarget = faceFor('idle', this.mood);
    for (const k of FACE_KEYS) this.face[k] = this.faceTarget[k] ?? 0;
    this.playBase(CLIPS.breathe, 0);
  }

  /** Loads the avatar and its clip library. Pass { renderer } at least once (for KTX2). */
  static async load(entry: AvatarManifestEntry, opts: AvatarOptions = {}): Promise<Avatar> {
    if (opts.renderer) configureAvatarLoader(opts.renderer);
    const [gltf, clips] = await Promise.all([loadAvatarGltf(entry), loadClips(entry.anims)]);
    return new Avatar(entry, gltf.scene, clips, opts);
  }

  /** Wraps an already loaded model (for example from an asset cache) and its clips. */
  static fromModel(entry: AvatarManifestEntry, model: Object3D, clips: AnimationClip[], opts: AvatarOptions = {}): Avatar {
    return new Avatar(entry, model, clips, opts);
  }

  get mode(): AvatarMode {
    return this._mode;
  }

  /** True while the voice is audible (for a speaking cue in the UI). */
  get isSpeaking(): boolean {
    return this.lip.isSpeaking;
  }

  /** Smoothed voice loudness 0..1. */
  get voiceLevel(): number {
    return this.lip.voiceLevel;
  }

  get lipSyncEngine(): LipSyncEngine {
    return this.lip.engine;
  }

  /** Seats the avatar: root at the seat, turned by yaw, raised so its hands rest on a table at deskY. */
  place(seat: SeatPose): void {
    this.root.position.set(seat.position.x, seat.deskY - CLIP_DESK_Y + this.yOffset, seat.position.z);
    this.root.rotation.set(0, seat.yaw, 0);
    this.root.updateMatrixWorld(true);
  }

  setMode(mode: AvatarMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    this.modeTime = 0;
    this.gaze.setMode(mode);
    this.faceTarget = faceFor(mode, this.mood);
    this.tiltTarget = mode === 'listening' ? (this.rng() < 0.5 ? -1 : 1) * between(this.rng, 2.5, 4) * DEG : 0;
    if (mode === 'thinking') this.blinker.trigger();
    // Thinking keeps the current body and only moves to the thoughtful clip if it lasts (see scheduleClips).
    if (mode !== 'thinking') this.playBase(this.baseFor(mode));
  }

  setMood(mood: Mood): void {
    this.mood = mood;
    this.faceTarget = faceFor(this._mode, mood);
  }

  /** What the avatar attends to (usually the user's head), world space. Null looks straight ahead. */
  lookAt(world: Vector3 | null): void {
    if (!world) this.lookWorld = null;
    else (this.lookWorld ??= new Vector3()).copy(world);
  }

  /** Gestures toward a world point (for example the board) for `seconds`, looking at it first. Null stops. */
  pointAt(world: Vector3 | null, seconds = 2.2): void {
    if (!world) {
      this.pointLeft = 0;
      return;
    }
    this.pointWorld.copy(world);
    this.pointLeft = seconds;
    this.pointT = 0;
    const local = this.rig.toRoot(world, this.vTarget);
    this.pointSide = local.x > 0.1 ? 'L' : 'R';
  }

  /** Drives lip sync from the interviewer's voice stream (analysis only; nothing is played). */
  async attachVoice(stream: MediaStream, ctx: AudioContext = sharedAudioContext()): Promise<LipSyncEngine> {
    await this.lip.attach(stream, ctx);
    return this.lip.engine;
  }

  detachVoice(): void {
    this.lip.detach();
  }

  /** Optional: the user's mic stream, so listening nods land on their pauses (loudness only, analysis only). */
  async attachUserVoice(stream: MediaStream, ctx: AudioContext = sharedAudioContext()): Promise<void> {
    this.userVoice?.detach();
    this.userVoice = new LipSync({ createVisemeSource: () => Promise.reject(new Error('loudness only')) });
    await this.userVoice.attach(stream, ctx);
  }

  /** Alternatively, tell the avatar when the user is talking (from the transport's VAD or transcripts). */
  setUserSpeaking(active: boolean): void {
    this.cues.userSpeech(active);
  }

  update(dtIn: number): void {
    const t0 = performance.now();
    const dt = Math.min(Math.max(dtIn, 0), 0.1);
    this.time += dt;
    this.modeTime += dt;
    const mode = this._mode;

    // Voice and conversational cues.
    const lip = this.lip.update(dt * 1000);
    if (this.userVoice) {
      this.userVoice.update(dt * 1000);
      this.cues.userSpeech(this.userVoice.isSpeaking);
    }
    const cue = this.cues.update(dt, mode === 'listening');
    if (cue === 'accept' && !this.oneShot) this.playOnce(this.pick([CLIPS.accept1, CLIPS.accept2, CLIPS.accept3]));
    else if (cue) this.nodder.trigger(between(this.rng, 3, 6) * DEG, between(this.rng, 0.6, 0.8), this.rng() < 0.2);
    const beat = this.beats.update(dt, this.lip.voiceLevel, mode === 'speaking');
    if (beat.phraseStart && this.rng() < 0.4) {
      const side = this.rng() < 0.5 ? -1 : 1;
      this.gaze.glance(side * between(this.rng, 6, 10) * DEG, between(this.rng, 2, 6) * DEG, between(this.rng, 0.4, 0.8));
    }

    // Clips.
    this.scheduleClips(dt);
    this.rig.restore();
    this.mixer.update(dt);
    this.rig.capture();

    // Gaze target in the root frame.
    this.rig.begin();
    const eye = this.rig.eyeCenter;
    if (this.pointLeft > 0) {
      this.pointLeft -= dt;
      this.pointT += dt;
      this.pointW = Math.min(1, this.pointW + dt / POINT_IN_S);
    } else this.pointW = Math.max(0, this.pointW - dt / POINT_OUT_S);
    // Look at what we point at for the first 0.9 s, then back at the user.
    const lookingAtPoint = this.pointLeft > 0 && this.pointT < 0.9;
    if (lookingAtPoint) this.rig.toRoot(this.pointWorld, this.vTarget);
    else if (this.lookWorld) this.rig.toRoot(this.lookWorld, this.vTarget);
    else this.vTarget.set(eye.x, eye.y - 0.05, eye.z + 1.2);
    anglesTo(eye, this.vTarget, this.aTrue);
    anglesTo(eye, gazeTarget(eye, this.vTarget, this.time, this.vAim), this.aHead);
    this.gaze.update(dt, this.aTrue, this.aHead);
    if (this.gaze.bigShift && this.rng() < 0.6) this.blinker.trigger();

    // Head, eyes, arms.
    this.tilt += (this.tiltTarget - this.tilt) * approach(dt, TILT_TAU_S);
    const nod = this.nodder.update(dt);
    this.rig.applyHead(this.gaze.headYaw, this.gaze.headPitch + nod + beat.head, this.tilt);
    const dist = Math.max(0.5, eye.distanceTo(this.vTarget));
    dirFromAngles(this.gaze.eyeYaw, this.gaze.eyePitch, this.vAim).multiplyScalar(dist).add(eye);
    this.rig.applyEyes(this.rig.toWorld(this.vAim, this.vWorld));
    if (beat.arms > 0) {
      this.rig.liftForearm('L', beat.arms * ARMS_LIFT);
      this.rig.liftForearm('R', beat.arms * ARMS_LIFT);
    }
    if (beat.armR > 0) this.rig.liftForearm('R', beat.armR * ARM_R_LIFT);
    if (this.pointW > 0) this.rig.reach(this.pointSide, this.pointWorld, smooth(this.pointW));

    // Face.
    const m = this.morphs;
    m.clear();
    const k = approach(dt, FACE_TAU_S);
    for (const key of FACE_KEYS) {
      const f = (this.face[key] ?? 0) + ((this.faceTarget[key] ?? 0) - (this.face[key] ?? 0)) * k;
      this.face[key] = f;
      if (f > 0) m.add(key, f);
    }
    for (const key in lip) {
      const v = lip[key]!;
      if (v > 0.001) m.add(key, v);
    }
    if (beat.brow > 0) {
      m.add('browInnerUp', beat.brow * 0.6);
      m.add('browOuterUpLeft', beat.brow);
      m.add('browOuterUpRight', beat.brow);
    }
    const blink = this.blinker.update(dt * 1000);
    // Lids follow the eyes a little when looking down.
    const lid = Math.max(0, -this.gaze.eyePitch / (20 * DEG)) * 0.25;
    m.setMax('eyeBlinkLeft', Math.max(blink, lid));
    m.setMax('eyeBlinkRight', Math.max(blink, lid));
    m.flush();

    this.record(performance.now() - t0, m.writes);
  }

  /** Frees GPU resources and stops audio analysis. */
  dispose(): void {
    this.lip.detach();
    this.userVoice?.detach();
    this.mixer.stopAllAction();
    this.root.removeFromParent();
    const seen = new Set<unknown>();
    this.model.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.geometry.dispose();
      const mats = (Array.isArray(o.material) ? o.material : [o.material]) as Material[];
      for (const mat of mats) {
        if (seen.has(mat)) continue;
        seen.add(mat);
        for (const v of Object.values(mat)) if (v && (v as Texture).isTexture) (v as Texture).dispose();
        mat.dispose();
      }
    });
  }

  // ---- clips ----

  /**
   * Base clip per mode. The idle_neutral clips look around the room (head turns up to 58 degrees), which fights eye
   * contact, so they only play in idle; listening and speaking stay on the breathing clip (head within 9 degrees)
   * and get their variety from tilts, nods, beats and the accept one-shots.
   */
  private baseFor(mode: AvatarMode): string {
    return mode === 'idle' ? this.pick([CLIPS.breathe, CLIPS.idle1, CLIPS.idle2]) : CLIPS.breathe;
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rng() * xs.length)]!;
  }

  private action(name: string): AnimationAction | null {
    let a = this.actions.get(name);
    if (!a) {
      const clip = this.clips.get(name);
      if (!clip) return null;
      a = this.mixer.clipAction(clip);
      this.actions.set(name, a);
    }
    return a;
  }

  private playBase(name: string, fade = FADE_S): void {
    const next = this.action(name);
    this.baseWait = between(this.rng, 14, 26);
    if (!next || next === this.base) return;
    next.reset();
    next.setLoop(LoopRepeat, Infinity);
    next.time = this.rng() * next.getClip().duration;
    if (fade > 0) next.fadeIn(fade);
    next.play();
    if (this.base && fade > 0) this.base.fadeOut(fade);
    else this.base?.stop();
    this.base = next;
    if (this.oneShot) {
      this.oneShot.fadeOut(fade || ONESHOT_FADE_S);
      this.oneShot = null;
    }
  }

  private playOnce(name: string): void {
    const a = this.action(name);
    if (!a || !this.base) return;
    a.reset();
    a.setLoop(LoopOnce, 1);
    a.clampWhenFinished = true;
    a.fadeIn(ONESHOT_FADE_S).play();
    this.base.fadeOut(ONESHOT_FADE_S);
    this.oneShot = a;
  }

  private scheduleClips(dt: number): void {
    if (this.oneShot) {
      const a = this.oneShot;
      if (a.time >= a.getClip().duration - ONESHOT_FADE_S - 0.05 || !a.isRunning()) {
        const b = this.base!;
        b.reset();
        b.time = this.rng() * b.getClip().duration;
        b.fadeIn(ONESHOT_FADE_S).play();
        a.fadeOut(ONESHOT_FADE_S);
        this.oneShot = null;
      }
      return;
    }
    if (this._mode === 'thinking') {
      if (this.modeTime >= THINK_CLIP_AFTER_S && this.base !== this.actions.get(CLIPS.thoughtful))
        this.playBase(CLIPS.thoughtful, 0.6);
      return;
    }
    // Every 14 to 26 s: idle may switch clips (looking around); a listener shifts the tilt of their head.
    this.baseWait -= dt;
    if (this.baseWait <= 0) {
      this.baseWait = between(this.rng, 14, 26);
      if (this._mode === 'idle') this.playBase(this.baseFor('idle'));
      if (this._mode === 'listening')
        this.tiltTarget = (this.rng() < 0.5 ? -1 : 1) * between(this.rng, 2.5, 4) * DEG;
    }
  }

  private record(ms: number, writes: number): void {
    const s = this.stats;
    s.lastMs = ms;
    s.morphWrites = writes;
    this.samples[this.sampleN++ % this.samples.length] = ms;
    const n = Math.min(this.sampleN, this.samples.length);
    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const v = this.samples[i]!;
      sum += v;
      if (v > max) max = v;
    }
    s.meanMs = sum / n;
    s.maxMs = max;
  }
}

/** three's shared AudioContext (the one its AudioListener uses), typed as the DOM one. */
const sharedAudioContext = (): AudioContext => ThreeAudioContext.getContext() as unknown as AudioContext;

const smooth = (u: number) => u * u * (3 - 2 * u);
