// Dev scene for /dev/avatar: one avatar seated at a table in a plain room, seen from where a seated user would be.
// Flat WebGL (no XR session) so it runs in the headless emulator browser and on a laptop alike.
//
// Query: ?id=f01 (avatar), ?view=seat|face|side, ?auto=1 (cycle the modes), ?sway=1 (the "user" moves side to
// side so the head follow shows), ?mood=warm|neutral|stern.

import {
  BoxGeometry,
  Clock,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  SRGBColorSpace,
  Scene,
  ACESFilmicToneMapping,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Avatar } from '../avatar';
import { manifestEntry } from '../loader';
import type { AvatarMode, Mood } from '../types';

export type DevView = 'seat' | 'face' | 'side';

export interface DevOptions {
  id: string;
  view: DevView;
  auto: boolean;
  sway: boolean;
  mood: Mood;
  voiceUrl: (sex: 'f' | 'm') => string;
}

export interface DevStatus {
  ready: boolean;
  error: string;
  id: string;
  mode: AvatarMode;
  engine: string;
  isSpeaking: boolean;
  voiceLevel: number;
  updateMeanMs: number;
  updateMaxMs: number;
  morphWrites: number;
  fps: number;
  calls: number;
  triangles: number;
  frozen: boolean;
}

/** The seated user's eyes: across the table, 1.45 m in front of the avatar root. */
const USER_EYE = new Vector3(0, 1.2, 1.45);
/** A board to the avatar's right, for pointAt. */
const BOARD = new Vector3(-1.05, 1.35, 0.55);

export class AvatarDevScene {
  readonly status: DevStatus;
  avatar: Avatar | null = null;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(50, 1, 0.05, 20);
  private readonly clock = new Clock();
  private readonly audio: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private frozen = false;
  private view: DevView;
  private readonly user = USER_EYE.clone();
  private t = 0;
  private frames = 0;
  private fpsT = 0;
  private autoT = 0;
  private autoStep = -1;
  private userTalkT = -1;
  private readonly onResize = () => this.resize();

  constructor(
    private readonly host: HTMLElement,
    private readonly opts: DevOptions,
  ) {
    this.view = opts.view;
    this.status = {
      ready: false,
      error: '',
      id: opts.id,
      mode: 'idle',
      engine: 'none',
      isSpeaking: false,
      voiceLevel: 0,
      updateMeanMs: 0,
      updateMaxMs: 0,
      morphWrites: 0,
      fps: 0,
      calls: 0,
      triangles: 0,
      frozen: false,
    };
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    host.append(this.renderer.domElement);
    this.audio = document.createElement('audio');
    this.audio.hidden = true;
    this.audio.preload = 'auto';
    this.audio.addEventListener('ended', () => this.avatar?.setMode('listening'));
    host.append(this.audio);
    this.buildRoom();
    this.resize();
    addEventListener('resize', this.onResize);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  async load(): Promise<void> {
    try {
      const entry = await manifestEntry(this.opts.id);
      this.audio.src = this.opts.voiceUrl(entry.sex);
      const a = await Avatar.load(entry, { renderer: this.renderer, mood: this.opts.mood, seed: 7 });
      a.place({ position: { x: 0, y: 0, z: 0 }, yaw: 0, deskY: 0.74 });
      this.scene.add(a.root);
      a.setMode('listening');
      this.avatar = a;
      this.status.ready = true;
    } catch (e) {
      this.status.error = e instanceof Error ? e.message : String(e);
      console.error(e);
    }
  }

  setMode(m: AvatarMode): void {
    if (m === 'speaking')
      this.speak().catch((e) => {
        // No user gesture yet (autoplay) or no capture: speak without a voice so the body still shows.
        this.status.error = `voice: ${e instanceof Error ? e.message : String(e)}`;
        this.avatar?.setMode('speaking');
      });
    else {
      this.audio.pause();
      this.avatar?.setMode(m);
    }
  }

  /** Plays the test voice through the hidden <audio> element; its captured stream drives the lip sync. */
  async speak(): Promise<void> {
    const a = this.avatar;
    if (!a) return;
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.audio.currentTime = 0;
    await this.audio.play();
    // Capture again on every play: Chrome ends the captured tracks when the element reaches its end.
    const el = this.audio as HTMLAudioElement & { captureStream?: () => MediaStream };
    if (!el.captureStream) throw new Error('this browser cannot capture an audio element stream');
    await a.attachVoice(el.captureStream(), this.ctx);
    a.setMode('speaking');
  }

  /** The "user" talks for 1.6 s, then pauses (the avatar should nod at the pause). */
  userTalks(): void {
    this.avatar?.setMode('listening');
    this.userTalkT = 0;
  }

  pointAtBoard(): void {
    this.avatar?.pointAt(BOARD);
  }

  setView(v: DevView): void {
    this.view = v;
  }

  freeze(on: boolean): void {
    this.frozen = on;
    this.status.frozen = on;
  }

  dispose(): void {
    removeEventListener('resize', this.onResize);
    this.renderer.setAnimationLoop(null);
    this.audio.pause();
    this.avatar?.dispose();
    void this.ctx?.close();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.audio.remove();
  }

  private buildRoom(): void {
    const s = this.scene;
    s.background = new Color(0xd9d5ce);
    const pmrem = new PMREMGenerator(this.renderer);
    s.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    s.environmentIntensity = 0.45;
    pmrem.dispose();
    s.add(new HemisphereLight(0xffffff, 0x8a8070, 1.1));
    const sun = new DirectionalLight(0xffffff, 1.5);
    sun.position.set(0.8, 2.5, 2);
    s.add(sun);
    const mat = (c: number) => new MeshStandardMaterial({ color: c, roughness: 0.85 });
    const floor = new Mesh(new PlaneGeometry(8, 8), mat(0xbdb8ae));
    floor.rotation.x = -Math.PI / 2;
    s.add(floor);
    const wall = new Mesh(new PlaneGeometry(8, 3), mat(0xe4e0d8));
    wall.position.set(0, 1.5, -1.3);
    s.add(wall);
    const seat = new Mesh(new BoxGeometry(0.48, 0.06, 0.46), mat(0x3a3a3a));
    seat.position.set(0, 0.44, -0.05);
    s.add(seat);
    const back = new Mesh(new BoxGeometry(0.46, 0.55, 0.05), mat(0x3a3a3a));
    back.position.set(0, 0.75, -0.3);
    s.add(back);
    // Table top at 0.74 m, from just in front of the avatar to past the user's side.
    const table = new Mesh(new BoxGeometry(1.5, 0.04, 1.0), mat(0x8b6b4a));
    table.position.set(0, 0.72, 0.75);
    s.add(table);
    const board = new Mesh(new BoxGeometry(0.04, 0.8, 1.2), mat(0xf4f4f2));
    board.position.copy(BOARD);
    s.add(board);
  }

  private resize(): void {
    const w = this.host.clientWidth || innerWidth;
    const h = this.host.clientHeight || innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private placeCamera(): void {
    const a = this.avatar;
    const cam = this.camera;
    if (this.view === 'face' && a) {
      const eye = a.root.getObjectByName(a.entry.head_bone)?.getWorldPosition(new Vector3()) ?? new Vector3(0, 1.25, 0);
      cam.fov = 30;
      cam.position.set(eye.x, eye.y + 0.06, eye.z + 0.75);
      cam.lookAt(eye.x, eye.y + 0.04, eye.z);
    } else if (this.view === 'side') {
      cam.fov = 40;
      cam.position.set(1.25, 1.35, 1.1);
      cam.lookAt(0, 1.05, 0.1);
    } else {
      cam.fov = 50;
      cam.position.copy(this.user);
      cam.lookAt(0, 1.0, 0);
    }
    cam.updateProjectionMatrix();
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const a = this.avatar;
    if (a && !this.frozen) {
      this.t += dt;
      if (this.opts.sway) this.user.set(0.4 * Math.sin(this.t * 0.8), 1.2 + 0.05 * Math.sin(this.t * 0.5), 1.45);
      if (this.opts.auto) this.runAuto(dt);
      if (this.userTalkT >= 0) {
        this.userTalkT += dt;
        a.setUserSpeaking(this.userTalkT < 1.6);
        if (this.userTalkT > 4) this.userTalkT = -1;
      }
      // The avatar looks at the seated user; in the face view the camera stands in for the user.
      this.placeCamera();
      a.lookAt(this.view === 'face' ? this.camera.position : this.user);
      a.update(dt);
    } else this.placeCamera();
    this.renderer.render(this.scene, this.camera);
    this.stats(dt);
  }

  private runAuto(dt: number): void {
    // idle 3 s, listening 8 s with the user talking and pausing, thinking 2 s, speaking until the voice ends.
    this.autoT += dt;
    const steps: [AvatarMode, number][] = [
      ['idle', 3],
      ['listening', 8],
      ['thinking', 2],
      ['speaking', Infinity],
    ];
    const cur = steps[this.autoStep];
    if (this.autoStep < 0 || (cur && this.autoT >= cur[1] && cur[0] !== 'speaking')) {
      this.autoStep = (this.autoStep + 1) % steps.length;
      this.autoT = 0;
      const [m] = steps[this.autoStep]!;
      if (m === 'listening') this.userTalks();
      this.setMode(m);
    } else if (cur?.[0] === 'speaking' && this.avatar?.mode === 'listening' && this.autoT > 1) {
      this.autoStep = 0;
      this.autoT = 0;
      this.setMode('idle');
    }
  }

  private stats(dt: number): void {
    this.frames++;
    this.fpsT += dt;
    const s = this.status;
    if (this.fpsT >= 0.5) {
      s.fps = Math.round(this.frames / this.fpsT);
      this.frames = 0;
      this.fpsT = 0;
    }
    const a = this.avatar;
    if (a) {
      s.mode = a.mode;
      s.engine = a.lipSyncEngine;
      s.isSpeaking = a.isSpeaking;
      s.voiceLevel = a.voiceLevel;
      s.updateMeanMs = a.stats.meanMs;
      s.updateMaxMs = a.stats.maxMs;
      s.morphWrites = a.stats.morphWrites;
    }
    s.calls = this.renderer.info.render.calls;
    s.triangles = this.renderer.info.render.triangles;
  }
}
