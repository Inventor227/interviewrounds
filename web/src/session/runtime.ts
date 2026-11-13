// The real room for one round: the round controller's dependencies built from the XR app, the
// avatars, the board, the head sampler and the room socket.
//
//   mic tap   → preload(session): room code, world and renderer, this round's people (model, clips,
//               lip sync model) and, in rounds with a board, the sheet. No XR session yet.
//   Enter tap → enter(): the XR session request, nothing else.
//   then      → place(): the desk; people appear when loaded and seated; voices are already
//               connecting (the controller does that).
//
// Everything heavy is imported on demand inside preload(), so registering this runtime costs the
// 2D pages nothing. The session page reads the live room through ./room.

import type { RuntimeOptions } from '../app/launch';
import { loadMe, setMe } from '../app/components/data';
import type { BoardXR } from '../board/boardXR';
import type { BoardPoint, PointerAdapter } from '../board/input';
import type { BoardStore } from '../board/ops';
import { api } from '../net/api';
import { SessionSocket } from '../net/ws';
import type { CreateSessionRes, Me, Panelist, Settings } from '../shared/types';
import { isMarker, type TransportOptions, type VoiceTransport } from '../voice/transport';
import type { Avatar } from '../xr/avatar';
import type { XRApp } from '../xr/world';
import { uploadBoard } from './boardImage';
import { syncBoard, type BoardSync } from './boardSync';
import * as browser from './browser';
import type { RoundControllerDeps } from './controller';
import { wireCues, type Cues } from './cues';
import { createHeadPort } from './headPort';
import { needsOnboarding, Onboarding } from './onboarding';
import { People, type AvatarLike } from './people';
import type { HeadSamplerPort, SocketPort, UiAction, XRPort, XRVisibilityLike } from './ports';
import { clearLiveRoom, setLiveRoom, type LiveRoom } from './room';
import { createRoundClock, itemCentre } from './roundClock';
import { StageTimings } from './timings';

/** Longest the mic tap waits for the avatars; slower ones appear when they are loaded. */
export const AVATAR_WAIT_MS = 12_000;
/** How long the start chime plays; the mic opens and the greeting is asked for only after it. */
export const START_CUE_MS = 650;
/** The board items are pointed at a little above the sheet (cm). */
const POINT_ABOVE_CM = 2;

type Cb = (p: BoardPoint) => void;

/** A pointer whose source arrives later (the preview's canvas mounts after the room is built). */
class RelayPointer implements PointerAdapter {
  private readonly sets = { down: new Set<Cb>(), move: new Set<Cb>(), up: new Set<Cb>(), cancel: new Set<Cb>() };
  private sub(set: Set<Cb>, cb: Cb): () => void {
    set.add(cb);
    return () => set.delete(cb);
  }
  onDown = (cb: Cb) => this.sub(this.sets.down, cb);
  onMove = (cb: Cb) => this.sub(this.sets.move, cb);
  onUp = (cb: Cb) => this.sub(this.sets.up, cb);
  onCancel = (cb: Cb) => this.sub(this.sets.cancel, cb);
  /** Forwards a source's events; returns an unbind. */
  bind(src: PointerAdapter): () => void {
    const fwd = (set: Set<Cb>) => (p: BoardPoint) => {
      for (const cb of [...set]) cb(p);
    };
    const offs = [src.onDown(fwd(this.sets.down)), src.onMove(fwd(this.sets.move)), src.onUp(fwd(this.sets.up)), src.onCancel?.(fwd(this.sets.cancel))];
    return () => offs.forEach((off) => off?.());
  }
  destroy(): void {
    for (const s of Object.values(this.sets)) s.clear();
  }
}

/** The session id of a room socket path (`/ws/session/{id}`), for the calls the room makes itself (the board picture). */
export function sessionIdOf(wsUrl: string): string | null {
  return /\/ws\/session\/([^/?#]+)/.exec(wsUrl)?.[1] ?? null;
}

/** Dev flags for emulator tooling: from the query, else from this tab's storage (they survive client routing). */
function devFlag(name: string): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    return new URLSearchParams(location.search).get(name) ?? sessionStorage.getItem(`ir_${name}`);
  } catch {
    return null;
  }
}

function after<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);
}

export function createRoundRuntime({ preview }: RuntimeOptions): RoundControllerDeps {
  const timings = new StageTimings();
  const changeCbs = new Set<() => void>();
  const changed = () => {
    for (const cb of [...changeCbs]) cb();
  };

  // The canvas lives here. In passthrough the page never shows it (the round is in the headset);
  // in the preview the session page moves this element into its stage.
  const host = document.createElement('div');
  host.dataset.test = 'room-host';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = preview
    ? 'position:fixed;left:-10000px;top:0;width:960px;height:540px;'
    : 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.append(host);

  let disposed = false;
  let userSpeaking = false;
  let app: XRApp | null = null;
  let port: (XRPort & { dispose(): void }) | null = null;
  let people: People | null = null;
  let board: BoardXR | null = null;
  let store: BoardStore | null = null;
  let sync: BoardSync | null = null;
  let socket: SessionSocket | null = null;
  let settings: Settings | null = null;
  let me: Me | null = null;
  let onboarding: Onboarding | null = null;
  let taught = false;
  /** Builds the board for a dominant hand (the tray goes opposite); set once the board's parts are loaded. */
  let makeBoard: ((hand: 'left' | 'right') => BoardXR) | null = null;
  let boardHand: 'left' | 'right' = 'right';
  let relay: RelayPointer | null = null;
  let cues: Cues | null = null;
  let sheetToWorld: ((x: number, y: number, h: number) => { x: number; y: number; z: number }) | null = null;
  const cleanups: (() => void)[] = [];
  const socketCleanups: (() => void)[] = [];
  let sessionId: string | null = null;
  let imageSent = false;
  const actionCbs = new Set<(a: UiAction) => void>();
  const gestureCbs = new Set<() => void>();
  const visibilityCbs = new Set<(v: XRVisibilityLike) => void>();
  const sessionEndCbs = new Set<(e: { byApp: boolean }) => void>();
  /** The round is paused: no cue plays, and nothing of the board or the user's words reaches the Scribe. */
  let paused = false;
  const activityCbs = new Set<() => void>();
  const active = () => {
    for (const cb of [...activityCbs]) cb();
  };

  const room: LiveRoom = {
    host,
    preview,
    timings,
    hasBoard: false,
    sessionLost: false,
    onChange(cb) {
      changeCbs.add(cb);
      return () => changeCbs.delete(cb);
    },
  };
  setLiveRoom(room);

  // ---------- the room socket: board sync and pointing ----------

  const clock = createRoundClock();
  const roundClock = () => clock.now_s();

  /** Binds the board, the cues and the pointing to the current room socket (again when the session was remade). */
  const wireSocket = () => {
    for (const c of socketCleanups.splice(0)) c();
    sync = null;
    cues = null;
    const so = socket;
    if (!so) return;
    if (store) {
      const sy = syncBoard(store, so);
      sync = sy;
      socketCleanups.push(() => sy.dispose());
    }
    if (app) {
      const a = app;
      const cu = wireCues((name) => a.sounds.play(name), so, { paused: () => paused });
      cues = cu;
      socketCleanups.push(() => cu.dispose());
    }
    socketCleanups.push(
      so.on('round.state', (d) => clock.sync(d.elapsed_s, d.status)),
      so.on('avatar.point_at', (d) => {
        const c = itemCentre(store?.board.items.find((i) => i.id === d.item_id));
        if (c && sheetToWorld) people?.pointAt(d.panelist_id, sheetToWorld(c.x, c.y, POINT_ABOVE_CM));
      }),
      so.on('round.ended', () => sendBoardImage()),
    );
  };

  /**
   * The sheet goes to the server as a picture for the report, once, when the round starts to end
   * (the server takes it while the round is live, paused or being scored). Nothing waits for it.
   */
  const sendBoardImage = () => {
    const canvas = board?.sheet.texture.image as HTMLCanvasElement | undefined;
    const id = sessionId;
    if (imageSent || !canvas || !id || typeof canvas.toBlob !== 'function') return;
    imageSent = true;
    void uploadBoard(canvas, (png) => api.uploadBoardImage(id, png)).then((ok) => {
      if (import.meta.env.DEV) console.info(`[round] board image ${ok ? 'sent' : 'not sent'}`);
    });
  };

  /** Frees everything preload built (also a half built room after a failed load), so it can be built again. */
  const teardown = () => {
    for (const c of socketCleanups.splice(0)) c();
    for (const c of cleanups.splice(0)) c();
    sync = null;
    cues = null;
    onboarding?.dispose();
    onboarding = null;
    makeBoard = null;
    board?.destroy();
    board = null;
    store = null;
    sheetToWorld = null;
    relay?.destroy();
    relay = null;
    people?.dispose();
    people = null;
    port?.dispose();
    port = null;
    app?.destroy();
    app = null;
    room.hasBoard = false;
    room.attachBoardCanvas = undefined;
    room.debug = undefined;
    if (import.meta.env.DEV) delete (globalThis as { __xrApp?: XRApp }).__xrApp;
  };

  // ---------- loading ----------

  async function loadPeople(a: XRApp, res: CreateSessionRes): Promise<void> {
    const [avatars, lip] = await Promise.all([import('../xr/avatar'), import('../xr/avatar/lipsync')]);
    if (disposed) return;
    const fade = makeFader();
    const crowd = new People({
      panel: res.panel,
      load: async (id) => Avatar_load(avatars, a, id),
      attach: (av) => a.room.root.add((av as Avatar).root),
      fade: (av, k) => fade((av as Avatar).root, k),
      onAppear: () => a.sceneChanged(),
    });
    people = crowd;
    // The viseme model rides along, so the first word already moves the lips.
    await Promise.all([crowd.load(), lip.preloadVisemeModel()]);
  }

  async function loadBoard(a: XRApp, res: CreateSessionRes): Promise<void> {
    const kitName = res.round.board_kit;
    if (!kitName) return;
    const [{ createBoardXR }, { BoardStore }, { emptyBoard }, { sheetToWorld: toWorld }, { dominantFor }] = await Promise.all([
      import('../board/boardXR'),
      import('../board/ops'),
      import('../board/model'),
      import('../board/sheetMath'),
      import('../board/tray'),
    ]);
    if (disposed) return;
    // The same empty board the server starts the round with: the kit, plus an empty code or meeting section.
    const start = emptyBoard({ id: res.session_id, kit: kitName });
    if (kitName === 'coding') start.code = { language: 'python', lines: [], approach: [], complexity: { time: null, space: null }, trace: [] };
    if (kitName === 'meeting') start.meeting = { agenda: [], shown: [], parked: [] };
    const s = new BoardStore(start);
    store = s;
    if (preview) relay = new RelayPointer();
    boardHand = dominantFor(null, settings?.dominant_hand);
    const build = (hand: 'left' | 'right') => createBoardXR(a, {
      store: s,
      dominantHand: hand,
      // The kit follows the board's round type; the round clock stamps traces and agenda ticks.
      now_s: roundClock,
      send: (op) => {
        sync?.send(op);
        active();
      },
      sendGhostReject: (id) => sync?.sendGhostReject(id),
      sendFocus: (id) => {
        if (!paused) sync?.sendFocus(id);
      },
      sfx: { play: (n) => a.sounds.play(n) },
      pointer: relay ?? undefined,
      ghostSettleMs: Number(devFlag('ghost_settle')) > 0 ? Number(devFlag('ghost_settle')) * 1000 : undefined,
    });
    board = build(boardHand);
    // The hand that touched the desk is the dominant one for this round, whatever the 2D setting says: the tray
    // (and in coding rounds the panel) is laid out again for it, before anything is on the sheet.
    makeBoard = (hand) => {
      const want = dominantFor(hand, settings?.dominant_hand);
      if (want !== boardHand && board) {
        board.destroy();
        boardHand = want;
        board = build(want);
      }
      return board!;
    };
    sheetToWorld = (x, y, h) => toWorld(a.sheetAnchor, x, y, h);
    wireSocket();
    if (import.meta.env.DEV) {
      const { ghostRect } = await import('../board/ghosts');
      room.debug = {
        store: s,
        toWorld: (pts: [number, number][], hCm = 0) => pts.map(([x, y]) => toWorld(a.sheetAnchor, x, y, hCm)),
        ghostRect: (opId: string) => {
          const g = s.board.ghosts.find((x) => x.op_id === opId);
          return g ? ghostRect(s.board, g) : null;
        },
      };
    }

    if (preview) {
      const [{ BoardView }, { MouseAdapter }] = await Promise.all([import('../board/render'), import('../board/mouse')]);
      const kit = board.kit;
      room.attachBoardCanvas = (canvas) => {
        const b = board;
        if (!b || !relay) return () => undefined;
        const view = new BoardView(canvas, {
          pxPerCm: 10,
          originCm: { x: kit.view.x, y: kit.view.y },
          widthCm: kit.view.w,
          heightCm: kit.view.h,
          kit,
          dpr: window.devicePixelRatio || 1,
          targets: 'mouse',
        });
        const mouse = new MouseAdapter(canvas, (x, y) => view.toBoard(x, y));
        const unbind = relay.bind(mouse);
        const fit = () => {
          const w = canvas.parentElement?.clientWidth ?? 0;
          if (w <= 0) return;
          const k = Math.max(4, w / kit.view.w);
          view.configure({ pxPerCm: k, dpr: window.devicePixelRatio || 1 });
          canvas.style.width = `${kit.view.w * k}px`;
          canvas.style.height = `${kit.view.h * k}px`;
        };
        const ro = typeof ResizeObserver !== 'undefined' && canvas.parentElement ? new ResizeObserver(fit) : null;
        if (canvas.parentElement) ro?.observe(canvas.parentElement);
        fit();
        const offFrame = a.onFrame((_dt, t) => {
          view.draw(s.board, { highlight: b.input.hover, overlays: b.input.overlays, rings: b.ghosts.rings(t) });
        });
        return () => {
          offFrame();
          ro?.disconnect();
          unbind();
          mouse.destroy();
        };
      };
    }
    room.hasBoard = true;
  }

  // ---------- the XR port ----------

  const ui: XRPort['ui'] = {
    setRoundState: (s) => port?.ui.setRoundState(s),
    showSummary: (r) => port?.ui.showSummary(r),
    showCard: (c, o) => port?.ui.showCard?.(c, o),
    setStatus: (t, p) => port?.ui.setStatus(t, p),
    setNotice: (k) => port?.ui.setNotice?.(k),
    setPaused(p) {
      paused = p;
      port?.ui.setPaused?.(p);
    },
    onAction(cb) {
      actionCbs.add(cb);
      return () => actionCbs.delete(cb);
    },
  };

  const xr: XRPort = {
    async preload(res) {
      if (app || disposed) return;
      try {
        await build(res);
      } catch (err) {
        // A half built room is never reused: the next try builds it again from nothing.
        teardown();
        throw err;
      }
    },
    enter() {
      // Synchronous on purpose: the XR request must run inside the Enter tap.
      if (!port) return Promise.reject(new Error('The room is not loaded'));
      return port.enter().then(() => {
        if (!room.sessionLost) return;
        room.sessionLost = false;
        changed();
      });
    },
    place: () => (port ? port.place() : Promise.reject(new Error('The room is not loaded'))),
    inSession: () => preview || !!app?.world.session,
    startCue() {
      // The desk is down: the round begins. The chime plays with every mic still closed.
      const a = app;
      if (!a || settings?.sfx_volume === 0) return Promise.resolve();
      if (cues) cues.roundStarted();
      else a.sounds.play('start');
      return new Promise<void>((r) => setTimeout(r, START_CUE_MS));
    },
    exit: () => port?.exit?.(),
    onGesture(cb) {
      gestureCbs.add(cb);
      return () => gestureCbs.delete(cb);
    },
    onVisibility(cb) {
      visibilityCbs.add(cb);
      return () => visibilityCbs.delete(cb);
    },
    onSessionEnd(cb) {
      sessionEndCbs.add(cb);
      return () => sessionEndCbs.delete(cb);
    },
    cue: (name) => app?.sounds.play(name),
    onboard,
    dispose() {
      if (disposed) return;
      disposed = true;
      teardown();
      host.remove();
      clearLiveRoom(room);
      // The managed emulator browser needs a world on the 2D pages again.
      if (import.meta.env.DEV && navigator.webdriver && devFlag('one_world') === '1') void import('../xr/devtools').then((m) => m.startToolingWorld()).catch(() => undefined);
    },
    ui,
    room: { seatPoses: () => port?.room.seatPoses() ?? [] },
  };

  /**
   * The first round with a sheet on this device: the ghost hand shows the one gesture and the round waits until the
   * user has drawn a box (or skipped). Asked again (a second Enter after leaving the headset view) it answers `none`
   * once it has been taught.
   */
  async function onboard(): Promise<'done' | 'skipped' | 'none'> {
    const a = app;
    const b = board;
    const s = store;
    if (!a || !b || !s || taught || !needsOnboarding({ kit: b.kit.id, done: me?.onboarding_done, preview })) return 'none';
    // The input lane's `activeInput()` and `onInputChange` once they exist on the app. Until then: hands when a
    // hand is tracked, else controllers.
    const input = a as unknown as { activeInput?: () => 'hands' | 'controllers'; onInputChange?: (cb: (i: 'hands' | 'controllers') => void) => () => void; controllerDrawing?: boolean };
    const active = () => input.activeInput?.() ?? (a.hands().some((h) => h.tracked) ? 'hands' : 'controllers');
    // CONTROLLER VARIANT: drawing on the sheet by controller is the input lane's (`controllerDrawing` on the app
    // when it lands). Without it a controller user could not do the step, so they are not asked to.
    if (!onboarding && active() === 'controllers' && !input.controllerDrawing) return 'none';
    if (!onboarding) {
      const { OnboardingView, ONBOARD_SKIP, ONBOARD_BEGIN } = await import('../xr/onboardingView');
      if (disposed || app !== a) return 'none';
      const skips = new Set<() => void>();
      const view = new OnboardingView();
      view.setInput(active());
      a.sheetAnchor.add(view.group);
      let shownLine: string | null = null;
      let beginTimer: ReturnType<typeof setTimeout> | null = null;
      // The line and Skip are on the status card: reachable by poke, pinch and controller ray like every other card.
      const showLine = () => {
        const line = view.line;
        if (!line) return;
        shownLine = line;
        a.ui.status.showText(line, '', null, [{ label: ONBOARD_SKIP, action: 'skip' }]);
      };
      const hideLine = (say: string | null) => {
        // Only our own line is taken down (a card of the round may have replaced it meanwhile).
        if (shownLine === null || a.ui.status.view.title !== shownLine) return;
        if (!say) {
          a.ui.hideStatus();
          a.ui.restoreNotice();
          return;
        }
        // The time ran out: a word that the round starts, then the card goes.
        shownLine = say;
        a.ui.status.showText(say);
        beginTimer = setTimeout(() => hideLine(null), 1800);
      };
      cleanups.push(
        () => view.dispose(),
        () => beginTimer && clearTimeout(beginTimer),
        a.onFrame((_dt, t) => view.update(t)),
        a.ui.onAction((act) => {
          if (act === 'skip') for (const cb of [...skips]) cb();
        }),
        input.onInputChange?.((i) => {
          view.setInput(i);
          showLine();
        }) ?? (() => undefined),
      );
      onboarding = new Onboarding({
        cards: () => s.board.items.filter((i) => i.kind !== 'ink').map((i) => ({ id: i.id })),
        onBoard: (cb) => s.onChange(() => cb()),
        show: (on, why) => {
          view.show(on, performance.now());
          if (on) showLine();
          else hideLine(why === 'timeout' ? ONBOARD_BEGIN : null);
        },
        onSkip: (cb) => {
          skips.add(cb);
          return () => skips.delete(cb);
        },
      });
      if (import.meta.env.DEV && room.debug) {
        const ob = onboarding;
        room.debug.onboarding = { showing: () => (ob.showing ? 'box' : null), skip: () => [...skips].forEach((cb) => cb()), view };
      }
    }
    const result = await onboarding.run();
    if (result === 'none') return 'none';
    taught = true;
    // The next round in this tab does not teach again (the server remembers it for later visits).
    if (me) {
      me = { ...me, onboarding_done: true };
      setMe(me);
    }
    return result;
  }

  async function build(res: CreateSessionRes): Promise<void> {
    {
      // In dev the managed emulator browser keeps a small tooling world on 2D pages; a script can ask to drop it.
      if (devFlag('one_world') === '1') await import('../xr/devtools').then((m) => m.stopToolingWorld()).catch(() => undefined);
      timings.begin('chunk');
      const [world, project, portMod, loaded] = await Promise.all([
        import('../xr/world'),
        import('virtual:iwsdk-project'),
        import('../xr/port'),
        loadMe().catch(() => null),
      ]);
      timings.mark('chunk_loaded');
      if (disposed) return;
      me = loaded;
      settings = loaded?.settings ?? null;
      const n = Math.max(1, Math.min(3, res.panel.length)) as 1 | 2 | 3;
      const fallbackS = Number(devFlag('fallback'));
      const a = await world.createXRApp(host, {
        mode: preview ? 'preview' : 'ar',
        base: project.default,
        seats: n,
        offer: devFlag('offer') === '1',
        standins: false,
        placementFallbackMs: fallbackS > 0 ? fallbackS * 1000 : undefined,
        isUserSpeaking: () => userSpeaking,
      });
      if (disposed) return a.destroy();
      app = a;
      if (import.meta.env.DEV) (globalThis as { __xrApp?: XRApp }).__xrApp = a;
      timings.mark('room_ready');

      const p = portMod.createXRPort(a);
      port = p;
      cleanups.push(
        p.ui.onAction((act) => {
          for (const cb of [...actionCbs]) cb(act);
        }),
        p.onGesture?.(() => {
          for (const cb of [...gestureCbs]) cb();
        }) ?? (() => undefined),
        a.onVisibility((v) => {
          for (const cb of [...visibilityCbs]) cb(v);
        }),
        a.onSessionEnd((e) => {
          if (disposed) return;
          // The controller first (it pauses a running round), then the page, which offers the way back.
          for (const cb of [...sessionEndCbs]) cb(e);
          onboarding?.suspend();
          if (e.byApp) return;
          room.sessionLost = true;
          changed();
        }),
      );
      if (settings) {
        a.ui.captions.setEnabled(settings.captions);
        a.ui.roundBar.setCaptions(settings.captions);
        a.sounds.setVolume(settings.sfx_volume);
      }

      const hasBoard = !!res.round.board_kit;
      a.room.setWallboardVisible(hasBoard);

      // Seats follow the desk; people follow the seats. The paper placeholder gives way to the
      // board's own sheet, and in rounds without a board there is no sheet at all.
      let lastDesk: unknown = null;
      const tmp = { x: 0, y: 0, z: 0 };
      cleanups.push(
        a.onFrame((dt) => {
          const desk = a.desk();
          if (desk !== lastDesk) {
            lastDesk = desk;
            if (desk) people?.place(a.room.seatPoses());
            if (desk?.hand && !preview) makeBoard?.(desk.hand);
            // The sheet is for drawing: the brief card stands beyond it instead of lying on it.
            if (desk && hasBoard && !preview) a.ui.layoutBriefBeyondSheet(desk);
          }
          if (a.room.sheet.visible) a.room.sheet.visible = false;
          const h = a.headPose().pos;
          tmp.x = h.x;
          tmp.y = h.y;
          tmp.z = h.z;
          people?.update(dt, tmp);
        }),
      );

      timings.begin('avatars');
      const peopleReady = loadPeople(a, res).then(() => {
        timings.mark('avatars_loaded');
        const desk = a.desk();
        if (desk) people?.place(a.room.seatPoses());
      });
      // A slow avatar never holds the start: it appears when it is loaded.
      await Promise.all([after(peopleReady, AVATAR_WAIT_MS), hasBoard ? loadBoard(a, res) : Promise.resolve()]);
      changed();
    }
  }

  // ---------- head, voices, socket ----------

  const head: HeadSamplerPort = (() => {
    let inner: HeadSamplerPort | null = null;
    let floor: string | null = null;
    const get = async () => {
      if (inner || !app) return inner;
      const a = app;
      const { HeadSampler } = await import('../xr/head');
      inner = createHeadPort({
        makeSampler: (send) => new HeadSampler({ send }),
        onFrame: (cb) => a.onFrame(cb),
        headPose: () => a.headPose(),
        targets: () => [...(people?.eyes() ?? []), ...(sheetToWorld ? [{ id: 'sheet', pos: sheetToWorld(32, 20, 0), coneDeg: 20 }] : [])],
      });
      if (floor) inner.setFloor(floor);
      return inner;
    };
    return {
      start: (sink) => void get().then((h) => !disposed && h?.start(sink)),
      stop: () => inner?.stop(),
      setUserSpeaking(b) {
        userSpeaking = b;
        people?.setUserSpeaking(b);
        inner?.setUserSpeaking(b);
      },
      setFloor(id) {
        floor = id;
        inner?.setFloor(id);
      },
    };
  })();

  const base = browser.makeTransport();
  const makeTransport = (p: Panelist, o: TransportOptions | undefined, res: CreateSessionRes): VoiceTransport => {
    const make = settings ? browser.makeTransport({ voice_speed: settings.voice_speed }) : base;
    const t = make(p, o, res);
    // Captions follow the words as they play; the board hears what the user said.
    t.on('agentText', (e) => app?.ui.setCaption(p.display_name, e.text));
    t.on('userTranscript', (e) => {
      if (e.final && !isMarker(e.text) && !paused) board?.say(e.text);
    });
    return t;
  };

  const makeSocket = (wsUrl: string, clientToken: string, lastSeq = 0): SocketPort => {
    socket = new SessionSocket(wsUrl, clientToken, { lastSeq });
    sessionId = sessionIdOf(wsUrl);
    wireSocket();
    return socket;
  };

  return {
    api,
    makeSocket,
    makeTransport,
    xr,
    media: browser.browserMedia,
    visibility: browser.pageVisibility,
    avatars: (id) => people?.port(id),
    board: {
      onActivity(cb) {
        activityCbs.add(cb);
        return () => activityCbs.delete(cb);
      },
      roundEnding: () => sendBoardImage(),
    },
    head,
    timings,
  };
}

async function Avatar_load(avatars: typeof import('../xr/avatar'), a: XRApp, id: string): Promise<AvatarLike> {
  const entry = await avatars.manifestEntry(id);
  return avatars.Avatar.load(entry, { renderer: a.world.renderer });
}

interface FadeMaterial {
  transparent: boolean;
  opacity: number;
  needsUpdate: boolean;
}

/** Fades an avatar in through its materials' opacity, then puts each material back as it was. */
function makeFader(): (root: Avatar['root'], k: number) => void {
  const saved = new Map<FadeMaterial, { transparent: boolean; opacity: number }>();
  return (root, k) => {
    root.traverse((o) => {
      const m = (o as { material?: FadeMaterial | FadeMaterial[] }).material;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) {
        let was = saved.get(mat);
        if (!was) {
          if (k >= 1) continue;
          was = { transparent: mat.transparent, opacity: mat.opacity };
          saved.set(mat, was);
          mat.transparent = true;
          mat.needsUpdate = true;
        }
        if (k >= 1) {
          mat.transparent = was.transparent;
          mat.opacity = was.opacity;
          mat.needsUpdate = true;
          saved.delete(mat);
        } else {
          mat.opacity = was.opacity * k;
        }
      }
    });
  };
}
