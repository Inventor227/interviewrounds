// The XR app: one IWSDK world for the round room, in passthrough (`ar`) or as a 2D preview in the page (`preview`).
//
// ar:      immersive-ar, hand tracking required, hit test and anchors optional, medium fixed foveation. 72 Hz,
//          raised to 90 only after the room and people are on screen and frames show headroom. Placement is
//          explicit: place() asks "Touch your desk where the sheet should go", builds the room around the desk and
//          anchors it. Everything placed belongs to one session: a session end forgets the desk and the anchor, hides
//          the room and rejects a pending place(). XRSession visibility changes pause a live round.
// preview: no WebXR. The same room in a calm virtual meeting room, camera at seated eye height, mouse input.
//
// The round controller drives it through createXRPort (port.ts).

import {
  createSystem,
  IBLTexture,
  PokeInteractable,
  RayInteractable,
  ReferenceSpaceType,
  SessionMode,
  signal,
  UIKitDocument,
  VisibilityState,
  World,
  type ReadonlySignal,
  type WorldOptions,
} from '@iwsdk/core';
import { ACESFilmicToneMapping, Matrix4, Quaternion, Vector3, type Material, type Mesh, type Object3D, type Scene, type Texture } from 'three';
import { FrameRateGovernor } from './framerate';
import { AnchorTracker, PlacementLifecycle } from './lifecycle';
import { yawPitchFromQuat } from './math';
import { DeskPlacement, type DeskPose, type HandState, type HeadPose } from './placement';
import { PlacementView } from './placementView';
import { buildPreviewRoom, MouseLook, PREVIEW_DESK, PREVIEW_FOV } from './preview';
import { Room } from './room';
import type { SeatPose } from './seats';
import { createSounds, type Sounds } from './sound';
import { DEFAULT_STANDINS, loadStandIn, placeStandIn, type StandIn } from './standin';
import { SelectRelay, type SelectCallback } from './select';
import { RoundUI } from './ui';

export type XRMode = 'ar' | 'preview';

export interface XRAppOptions {
  mode: XRMode;
  /** Panelists to seat (default 1). */
  seats?: 1 | 2 | 3;
  /** Dev/emulator: offer the session so tooling can accept it (`iwsdk xr enter`). */
  offer?: boolean;
  /** Load converted avatars as stand-ins on the seats (screens and preview until the avatar runtime seats people). */
  standins?: boolean | string[];
  /** Base world options (from iwsdk.config.json via virtual:iwsdk-project). */
  base?: WorldOptions;
  /** How long placement waits for a touch before the head-height fallback (default 6 s; tooling raises it). */
  placementFallbackMs?: number;
}

export interface RenderStats {
  calls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  programs: number;
  fps: number;
  /** Views rendered per frame (2 in a stereo session) and whether they share draw calls (multiview). */
  views: number;
  multiview: boolean;
  /** Draw calls per eye: calls / views without multiview. */
  callsPerView: number;
  /** The session's target frame rate (72 until measured headroom allows 90), null outside a session. */
  targetFps: number | null;
}

/** XRSession visibility: 'visible', 'visible-blurred' (system menu over the app) or 'hidden' (headset off). */
export type XRVisibility = 'visible' | 'visible-blurred' | 'hidden';

export interface XRApp {
  world: World;
  scene: Scene;
  mode: XRMode;
  room: Room;
  ui: RoundUI;
  sounds: Sounds;
  /** Enters the immersive session (ar; needs a user gesture). A second call while pending returns the same promise. */
  enter(): Promise<void>;
  exit(): void;
  /** Ends the session and frees the renderer, the WebGL context, textures and geometry. */
  destroy(): void;
  /** Per-frame callback after the world's systems; dt in seconds. Returns an unsubscribe. */
  onFrame(cb: (dt: number, nowMs: number) => void): () => void;
  headPose(): HeadPose;
  /** Live hand states, updated in place each XR frame (read them; do not keep or mutate). */
  hands(): HandState[];
  /** XR selectstart / selectend per hand: a pinch on hands, the trigger on controllers. */
  onSelect(cb: SelectCallback): () => void;
  /** The sheet frame (Room.sheetAnchor): origin at the near edge centre, +X right, -Z far, +Y the surface normal. */
  readonly sheetAnchor: Object3D;
  /** The placed desk of this session, or null (same as desk$.value). */
  desk(): DeskPose | null;
  /** Shows a texture on the wall board (the board mirrors the sheet); null clears it. */
  wallboardTexture(tex: Texture | null): void;
  visibility$: ReadonlySignal<VisibilityState>;
  /**
   * XRSession visibility changes (Quest system menu, headset off). The app also asks the round UI to pause by
   * itself (a 'pause' action, so the Resume card shows) when a live round loses visibility.
   */
  onVisibility(cb: (v: XRVisibility) => void): () => void;
  /** The immersive session ended; byApp is true when exit() asked for it (End), false for the system or the user. */
  onSessionEnd(cb: (e: { byApp: boolean }) => void): () => void;
  /** The placed desk of this session, null until placement finishes (and again after the session ends). */
  desk$: ReadonlySignal<DeskPose | null>;
  /**
   * The desk for this session: starts placement on the first call (never automatically), shares the placement in
   * flight, resolves at once when already placed. Rejects with PlacementCancelled without a session or when the
   * session ends first. In preview it resolves with the preview desk.
   */
  place(): Promise<DeskPose>;
  /** Places the desk again in the same session ("Move sheet"). */
  replace(): Promise<DeskPose>;
  /** Restart the frame rate measurement (call after adding people or other heavy content). */
  sceneChanged(): void;
  /** Re-seats the room for 1 to 3 people. */
  setSeats(n: 1 | 2 | 3): SeatPose[];
  standins(): StandIn[];
  stats(): RenderStats;
}

const TIPS = ['thumb-tip', 'index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'] as const;

type FrameCb = (dt: number, nowMs: number) => void;
const hooks = new WeakMap<World, Set<FrameCb>>();
const frameStarts = new WeakMap<World, number>();

/** Runs first each frame so the frame's CPU time (systems + render) can be measured. */
class FrameStartSystem extends createSystem({}) {
  override update(): void {
    frameStarts.set(this.world as World, performance.now());
  }
}

class FrameHookSystem extends createSystem({}) {
  override update(delta: number): void {
    const set = hooks.get(this.world as World);
    if (!set) return;
    const now = performance.now();
    for (const cb of set) cb(delta, now);
  }
}

function newHand(hand: 'left' | 'right'): HandState {
  const tips = TIPS.map(() => ({ x: 0, y: 0, z: 0 }));
  return { hand, tracked: false, indexTip: { x: 0, y: 0, z: 0 }, thumbTip: tips[0]!, tips, pinch: 0 };
}

/** Frees geometry, materials and their textures under an object. */
function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) disposeMaterial(mat);
  });
}

function disposeMaterial(mat: Material | undefined): void {
  if (!mat) return;
  for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
    if (v && typeof v === 'object' && (v as Texture).isTexture) (v as Texture).dispose();
  }
  mat.dispose();
}

export async function createXRApp(root: HTMLElement, opts: XRAppOptions): Promise<XRApp> {
  const mode = opts.mode;
  let seatsN: 1 | 2 | 3 = opts.seats ?? 1;
  const base = opts.base ?? {};
  const options: WorldOptions =
    mode === 'ar'
      ? {
          ...base,
          xr: {
            sessionMode: SessionMode.ImmersiveAR,
            referenceSpace: ReferenceSpaceType.LocalFloor,
            // Tooling re-offers after every exit so a script can enter again.
            offer: opts.offer ? 'always' : 'none',
            // Plane and mesh detection stay off: they would add a permission prompt before the room appears.
            features: { handTracking: { required: true }, hitTest: true, anchors: true },
          },
          render: { near: 0.01, far: 50, ...base.render },
          features: { ...base.features, sceneUnderstanding: false },
        }
      : {
          ...base,
          xr: false,
          render: { near: 0.01, far: 50, ...base.render, fov: PREVIEW_FOV },
          features: { ...base.features, sceneUnderstanding: false, environmentRaycast: false },
        };

  const world = await World.create(root, options);
  const { renderer, scene, camera } = world;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = mode === 'ar' ? 0.9 : 1.0;
  renderer.xr.setFoveation(0.5);
  world.registerSystem(FrameStartSystem, { priority: -100 });
  world.registerSystem(FrameHookSystem, { priority: 10 });
  const frameCbs = new Set<FrameCb>();
  hooks.set(world, frameCbs);

  // Neutral indoor IBL so skin and cloth do not look plastic; the room adds one soft key light.
  world.activeLevel.value.addComponent(IBLTexture, { src: 'room', intensity: mode === 'ar' ? 0.85 : 0.6 });

  const sounds = createSounds();
  const room = new Room(world, { mode });
  const ui = new RoundUI(sounds);
  const placementView = new PlacementView();
  placementView.group.visible = false;
  scene.add(placementView.group, ui.hint.group);

  // Panels are entities so rays, pokes and the mouse reach them.
  const panelEntities = Object.values(ui.groups).map((g) => {
    const e = world.createTransformEntity(g);
    e.addComponent(RayInteractable);
    e.addComponent(PokeInteractable);
    return e;
  });

  const desk$ = signal<DeskPose | null>(null);
  let standins: StandIn[] = [];
  const wantStandins = opts.standins === true ? DEFAULT_STANDINS : Array.isArray(opts.standins) ? opts.standins : [];

  // ---- head and hands ----
  const tmpV = new Vector3();
  const tmpQ = new Quaternion();
  const headPose = (): HeadPose => {
    const src: Object3D = mode === 'ar' && world.session ? world.player.head : camera;
    src.getWorldPosition(tmpV);
    src.getWorldQuaternion(tmpQ);
    const { yaw, pitch } = yawPitchFromQuat(tmpQ);
    return { pos: { x: tmpV.x, y: tmpV.y, z: tmpV.z }, yaw, pitch };
  };

  // Two hand states, updated in place every XR frame (no per-frame allocation).
  const left = newHand('left');
  const right = newHand('right');
  const handStates: HandState[] = [left, right];
  let controllersHinted = false;
  let lastXRFrameAt: number | null = null;
  let lastInterval = 0;

  const anchorM = new Matrix4();
  const anchors = new AnchorTracker((m) => room.setAnchorOffset(anchorM.fromArray(m)));

  world.onXRFrame((frame) => {
    const now = performance.now();
    lastInterval = lastXRFrameAt === null ? 0 : now - lastXRFrameAt;
    lastXRFrameAt = now;
    const ref = world.xrReferenceSpace;
    const session = world.session;
    if (!ref || !session) return;
    left.tracked = false;
    right.tracked = false;
    let controllers = false;
    for (const src of session.inputSources) {
      const hand = src.hand;
      if (!hand) {
        if (src.gamepad && src.targetRayMode === 'tracked-pointer') controllers = true;
        continue;
      }
      const h = src.handedness === 'left' ? left : src.handedness === 'right' ? right : null;
      if (!h) continue;
      let ok = true;
      for (let i = 0; i < TIPS.length; i++) {
        const space = hand.get(TIPS[i]!);
        const pose = space ? frame.getJointPose?.(space, ref) : undefined;
        if (!pose) {
          ok = false;
          break;
        }
        const p = pose.transform.position;
        const t = h.tips[i]!;
        t.x = p.x;
        t.y = p.y;
        t.z = p.z;
      }
      if (!ok) continue;
      h.tracked = true;
      const thumb = h.tips[0]!;
      const index = h.tips[1]!;
      h.indexTip.x = index.x;
      h.indexTip.y = index.y;
      h.indexTip.z = index.z;
      const d = Math.hypot(thumb.x - index.x, thumb.y - index.y, thumb.z - index.z);
      h.pinch = Math.max(0, Math.min(1, 1 - (d - 0.012) / 0.03));
    }
    if (controllers && !controllersHinted) {
      controllersHinted = true;
      ui.layoutHint(headPose());
      ui.showHint('Put your controllers down; use your hands', now, 7000);
    }
    anchors.update(frame, ref);
  });

  const createAnchor = async (desk: DeskPose) => {
    const gen = anchors.begin();
    const frame = world.xrFrame;
    const ref = world.xrReferenceSpace;
    if (!frame || !ref || typeof frame.createAnchor !== 'function') return;
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), desk.yaw);
    try {
      const a = await frame.createAnchor(new XRRigidTransform({ ...desk.origin }, { x: q.x, y: q.y, z: q.z, w: q.w }), ref);
      if (!a) return;
      const inv = new Matrix4().compose(new Vector3(desk.origin.x, desk.origin.y, desk.origin.z), q, new Vector3(1, 1, 1)).invert();
      anchors.adopt(gen, a as unknown as { anchorSpace: XRSpace; delete?(): void }, Float32Array.from(inv.elements));
    } catch {
      // Anchors are optional; the room stays where it was placed.
    }
  };

  // ---- placing the room ----
  const attachUI = () => {
    const g = ui.groups;
    if (mode === 'preview') {
      for (const k of ['roundBar', 'brief', 'captions'] as const) camera.add(g[k]);
      ui.setOverlay(['roundBar', 'brief', 'captions']);
      room.root.add(g.status, g.summary);
      layoutPreviewHud();
    } else {
      room.root.add(...Object.values(g));
    }
  };

  const build = (desk: DeskPose) => {
    const seats = room.place(desk, seatsN);
    if (mode === 'preview') room.addFloorShadows(0);
    if (mode === 'preview') ui.layoutDesk(desk, ['roundBar', 'brief', 'captions']);
    else ui.layoutDesk(desk);
    for (const [i, s] of standins.entries()) {
      const seat = seats[i];
      s.object.visible = !!seat;
      if (seat) placeStandIn(s, seat);
    }
    return seats;
  };

  // Stand-ins load per seat as needed (no GLBs for empty seats).
  let standinsLoading: Promise<void> | null = null;
  const loadStandins = (): Promise<void> => {
    const need = wantStandins.slice(standins.length, seatsN);
    if (need.length === 0) return standinsLoading ?? Promise.resolve();
    const prev = standinsLoading ?? Promise.resolve();
    standinsLoading = prev.then(async () => {
      const ids = wantStandins.slice(standins.length, seatsN);
      const loaded = await Promise.all(
        ids.map((id) =>
          loadStandIn(renderer, id).catch((e) => {
            console.warn('[xr] stand-in failed', id, e);
            return null;
          }),
        ),
      );
      if (destroyed) {
        for (const s of loaded) if (s) disposeTree(s.object);
        return;
      }
      for (const s of loaded) {
        if (!s) continue;
        standins.push(s);
        room.root.add(s.object);
      }
      const desk = desk$.value;
      if (desk) build(desk);
      else for (const s of standins) s.object.visible = false;
      sceneChanged();
    });
    return standinsLoading;
  };

  let placing: { p: DeskPlacement; laidOut: HeadPose | null } | null = null;
  const lifecycle = new PlacementLifecycle({
    start: () => {
      placing = { p: new DeskPlacement(performance.now(), opts.placementFallbackMs), laidOut: null };
      placementView.reset();
      placementView.group.visible = true;
      ui.setStatus('placing');
    },
    reset: () => {
      placing = null;
      placementView.group.visible = false;
      anchors.reset();
      room.setAnchorOffset(new Matrix4());
      if (mode === 'ar') room.root.visible = false;
      if (ui.status.group.parent === scene) {
        room.root.add(ui.status.group);
        ui.hideStatus();
      }
      desk$.value = null;
      governor?.disarm();
    },
  });

  const finishPlacement = (desk: DeskPose, now: number) => {
    placing = null;
    room.setAnchorOffset(new Matrix4());
    build(desk);
    room.root.visible = true;
    placementView.finish(room.sheet, now);
    ui.hideStatus();
    // Back in a paused round (the resume path): keep the Resume card up.
    if (ui.paused) ui.setStatus('paused');
    if (desk.source === 'fallback') {
      ui.layoutHint(headPose());
      ui.showHint('No desk? We set one up for you.', now, 6000);
    }
    sounds.flap();
    desk$.value = desk;
    void createAnchor(desk);
    lifecycle.finished(desk);
    sceneChanged();
  };

  // ---- preview camera ----
  let mouse: MouseLook | null = null;
  let previewRest: HeadPose | null = null;
  let previewGroup: Object3D | null = null;
  const layoutPreviewHud = () => {
    const w = root.clientWidth || window.innerWidth;
    const h = root.clientHeight || window.innerHeight;
    ui.layoutHud(w / h, camera.fov);
  };
  const buildPreview = () => {
    if (previewGroup) {
      previewGroup.removeFromParent();
      disposeTree(previewGroup);
    }
    const seats = room.seatPoses();
    const pr = buildPreviewRoom(PREVIEW_DESK, seatsN, seats);
    previewGroup = pr.group;
    world.activeLevel.value.object3D!.add(pr.group);
    previewRest = pr.rest;
  };

  let resizeObs: ResizeObserver | null = null;
  let fitRaf = 0;
  if (mode === 'preview') {
    // Fit the canvas to its container. IWSDK's own window resize handler sizes the canvas to the window (pixels in
    // its style); fit() runs after it and puts the canvas back into the stage.
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    const fit = () => {
      const w = root.clientWidth;
      const h = root.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      layoutPreviewHud();
    };
    const fitAfterResize = () => {
      cancelAnimationFrame(fitRaf);
      fit();
      fitRaf = requestAnimationFrame(fit);
    };
    resizeObs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fitAfterResize) : null;
    resizeObs?.observe(root);
    window.addEventListener('resize', fitAfterResize);
    world.addCleanup(() => window.removeEventListener('resize', fitAfterResize));
    fit();
    mouse = new MouseLook(canvas);
    attachUI();
    desk$.value = PREVIEW_DESK;
    build(PREVIEW_DESK);
    buildPreview();
  } else {
    attachUI();
    room.root.visible = false;
  }

  // ---- frame rate (ar) ----
  type RateSession = XRSession & { supportedFrameRates?: Float32Array; frameRate?: number; updateTargetFrameRate?(r: number): Promise<void> };
  let governor: FrameRateGovernor | null = null;
  let targetFps: number | null = null;
  /** The scene grew (room placed, people loaded): measure from here, after a short settle. */
  let armAt: number | null = null;
  function sceneChanged(): void {
    if (!governor || !lifecycle.desk) return;
    governor.disarm();
    armAt = performance.now() + 1500;
  }

  // Frame CPU time = from the first system to the end of render submit; the XR frame interval shows GPU stalls.
  const render = renderer.render.bind(renderer);
  renderer.render = (s, c) => {
    render(s, c);
    const session = world.session as RateSession | undefined;
    if (!governor || !session || session.visibilityState !== 'visible') return;
    const now = performance.now();
    if (armAt !== null && now >= armAt) {
      armAt = null;
      governor.arm(now);
    }
    const start = frameStarts.get(world);
    if (start === undefined || lastInterval <= 0) return;
    const rate = governor.frame(now - start, lastInterval, now);
    if (!rate || !session.updateTargetFrameRate) return;
    const g = governor;
    session
      .updateTargetFrameRate(rate)
      .then(() => {
        targetFps = rate;
        console.info(`[xr] frame rate ${g.describe()}`);
      })
      .catch(() => {
        g.refused();
        console.info(`[xr] frame rate ${rate} Hz refused; staying at 72 Hz`);
      });
  };

  // ---- per frame ----
  let fps = 0;
  let fpsAcc = 0;
  let fpsN = 0;
  frameCbs.add((dt, now) => {
    fpsAcc += dt;
    fpsN++;
    if (fpsAcc >= 0.5) {
      fps = fpsN / fpsAcc;
      fpsAcc = 0;
      fpsN = 0;
    }
    if (mode === 'preview' && mouse && previewRest) mouse.apply(camera, previewRest, dt);
    if (placing) {
      const head = headPose();
      // The prompt follows the head lazily: re-placed only after a real move or turn.
      const last = placing.laidOut;
      const moved = !last || Math.hypot(head.pos.x - last.pos.x, head.pos.y - last.pos.y, head.pos.z - last.pos.z) > 0.25;
      const turned = !!last && Math.abs(Math.atan2(Math.sin(head.yaw - last.yaw), Math.cos(head.yaw - last.yaw))) > 0.6;
      if (head.pos.y > 0.4 && (moved || turned)) {
        ui.layoutHeadStatus(head);
        if (ui.status.group.parent !== scene) scene.add(ui.status.group);
        placing.laidOut = head;
      }
      const st = placing.p.update(now, head, handStates);
      placementView.update(head, st, now);
      if (st.state === 'done' && st.result) {
        room.root.add(ui.status.group);
        finishPlacement(st.result, now);
      }
    }
    placementView.animate(now);
    ui.update(dt, now);
    for (const s of standins) if (s.object.visible) s.mixer.update(dt);
  });

  // ---- session lifecycle: frame rate, foveation, visibility, end ----
  const selects = new SelectRelay();
  const visCbs = new Set<(v: XRVisibility) => void>();
  const endCbs = new Set<(e: { byApp: boolean }) => void>();
  let exitByApp = false;
  type EnterWaiter = { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void; poll: ReturnType<typeof setInterval> | null };
  let enterWaiter = null as EnterWaiter | null;
  let destroyed = false;

  const onSessionStart = () => {
    const s = renderer.xr.getSession() as RateSession | null;
    // Start at 72 Hz (the WebXR default on Quest); 90 only after measured headroom with the full scene.
    const rates = s?.supportedFrameRates ? Array.from(s.supportedFrameRates) : [];
    governor = new FrameRateGovernor(rates.map((r) => Math.round(r)));
    targetFps = s?.frameRate ? Math.round(s.frameRate) : 72;
    if (s?.updateTargetFrameRate && rates.some((r) => Math.round(r) === 72)) {
      s.updateTargetFrameRate(72)
        .then(() => {
          if (governor?.rate === 72) targetFps = 72;
        })
        .catch(() => {});
    }
    console.info(`[xr] frame rate 72 Hz to start; offered: ${rates.join(', ') || 'unknown'}`);
    renderer.xr.setFoveation(0.5);
    exitByApp = false;
    controllersHinted = false;
    lastXRFrameAt = null;
    s?.addEventListener('visibilitychange', () => {
      const v = s.visibilityState as XRVisibility;
      if (v !== 'visible') ui.systemPause();
      for (const cb of visCbs) cb(v);
    });
    if (s) selects.attach(s);
    lifecycle.sessionStarted();
    if (enterWaiter) {
      if (enterWaiter.poll) clearInterval(enterWaiter.poll);
      enterWaiter.resolve();
      enterWaiter = null;
    }
  };
  const onSessionEnd = () => {
    selects.detach();
    left.tracked = false;
    right.tracked = false;
    lifecycle.sessionEnded();
    governor = null;
    targetFps = null;
    armAt = null;
    const byApp = exitByApp;
    exitByApp = false;
    if (!byApp) ui.systemPause();
    for (const cb of endCbs) cb({ byApp });
  };
  renderer.xr.addEventListener('sessionstart', onSessionStart);
  renderer.xr.addEventListener('sessionend', onSessionEnd);

  void loadStandins();

  const app: XRApp = {
    world,
    scene,
    mode,
    room,
    ui,
    sounds,
    enter() {
      if (mode === 'preview' || world.session) return Promise.resolve();
      if (enterWaiter) return enterWaiter.promise;
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const w: EnterWaiter = { promise, resolve, reject, poll: null };
      enterWaiter = w;
      const fail = (e: Error) => {
        if (w.poll) clearInterval(w.poll);
        if (enterWaiter === w) enterWaiter = null;
        w.reject(e);
      };
      try {
        world.launchXR();
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
        return promise;
      }
      // launchXR reports failures only to the console: notice when the request ends without a session.
      const started = performance.now();
      w.poll = setInterval(() => {
        if (world.session) return;
        if (!world.sessionRequestPending && performance.now() - started > 500) fail(new Error('The headset did not start the session.'));
      }, 250);
      return promise;
    },
    exit() {
      if (mode !== 'ar' || !world.session) return;
      exitByApp = true;
      world.exitXR();
    },
    onVisibility(cb) {
      visCbs.add(cb);
      return () => visCbs.delete(cb);
    },
    onSessionEnd(cb) {
      endCbs.add(cb);
      return () => endCbs.delete(cb);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (enterWaiter?.poll) clearInterval(enterWaiter.poll);
      enterWaiter?.reject(new Error('The room was closed.'));
      enterWaiter = null;
      const session = world.session;
      exitByApp = true;
      session?.end().catch(() => {});
      renderer.xr.removeEventListener('sessionstart', onSessionStart);
      renderer.xr.removeEventListener('sessionend', onSessionEnd);
      selects.detach();
      lifecycle.sessionEnded();
      cancelAnimationFrame(fitRaf);
      resizeObs?.disconnect();
      mouse?.dispose();
      frameCbs.clear();
      hooks.delete(world);
      for (const e of panelEntities) e.destroy();
      // Panels (UIKit documents and their glyph atlases), the hold ring, placement visuals, people and the room.
      for (const g of [...Object.values(ui.groups), ui.hint.group]) {
        g.traverse((o) => {
          if (o instanceof UIKitDocument) o.dispose();
        });
        disposeTree(g);
      }
      disposeTree(placementView.group);
      for (const s of standins) {
        s.mixer.stopAllAction();
        disposeTree(s.object);
      }
      standins = [];
      if (previewGroup) disposeTree(previewGroup);
      room.dispose();
      world.destroy();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
    onFrame(cb) {
      frameCbs.add(cb);
      return () => frameCbs.delete(cb);
    },
    headPose,
    hands: () => handStates,
    onSelect: (cb) => selects.on(cb),
    sheetAnchor: room.sheetAnchor,
    desk: () => desk$.value,
    wallboardTexture: (tex) => room.wallboardTexture(tex),
    visibility$: world.visibilityState,
    desk$,
    place() {
      if (mode === 'preview') return Promise.resolve(PREVIEW_DESK);
      return lifecycle.place();
    },
    replace() {
      if (mode === 'preview') return Promise.resolve(PREVIEW_DESK);
      return lifecycle.replace();
    },
    sceneChanged,
    setSeats(n) {
      seatsN = n;
      void loadStandins();
      const desk = desk$.value;
      if (!desk) return [];
      const seats = build(desk);
      if (mode === 'preview') buildPreview();
      sceneChanged();
      return seats;
    },
    standins: () => standins,
    stats() {
      const i = renderer.info;
      const xrCam = renderer.xr.isPresenting ? renderer.xr.getCamera() : null;
      const views = xrCam ? Math.max(1, xrCam.cameras.length) : 1;
      const multiview = !!(renderer.xr as unknown as { isMultiview?: boolean }).isMultiview;
      return {
        views,
        multiview,
        callsPerView: multiview ? i.render.calls : Math.round(i.render.calls / views),
        calls: i.render.calls,
        triangles: i.render.triangles,
        points: i.render.points,
        lines: i.render.lines,
        geometries: i.memory.geometries,
        textures: i.memory.textures,
        programs: i.programs?.length ?? 0,
        targetFps,
        fps: Math.round(fps * 10) / 10,
      };
    },
  };
  return app;
}
