// Panels with a controller: the aim ray with the trigger presses every button the way a poke or a pinch does, and
// the room never tells anyone to put the controllers down.
import { UIKitDocument } from '@iwsdk/core';
import { createRayPointer } from '@pmndrs/pointer-events';
import { Object3D, PerspectiveCamera, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { NOTICES, type NoticeKind } from '../../session/notices';
import { RoundUI } from './index';
import { layoutDesk } from './layout';
import { END_HOLD_MS, RoundBar } from './roundBar';
import { PLACING_COPY, PLACING_MISSED_LINE, STATUS_COPY } from './statusCard';
import { button } from './style';
import type { RoundAction } from './types';

const DESK = { origin: { x: 0, y: 0.74, z: -0.4 }, yaw: 0.2, deskY: 0.74, head: { x: 0.04, y: 1.19, z: -0.2 } };

/** A controller's aim ray as the room's pointer system drives it: a ray pointer on a space, the trigger as button 0. */
function rayRig(scene: Scene) {
  const space = new Object3D();
  scene.add(space);
  const camera = new PerspectiveCamera();
  const pointer = createRayPointer(() => camera, { current: space }, {}, { clickThresholdMs: 800, contextMenuButton: -1 });
  let t = 0;
  const ev = (button = 0) => ({ timeStamp: (t += 16), button });
  return {
    /** Holds the controller at `from` and aims its ray at `target` (world). */
    aim(from: Vector3, target: Vector3) {
      // One frame of the panels (the room's UI system lays them out every frame).
      scene.traverse((o) => {
        if (o instanceof UIKitDocument) (o.rootElement as unknown as { update(dt: number): void }).update(1 / 72);
      });
      space.position.copy(from);
      space.lookAt(target);
      // lookAt points +Z at the target for a plain object; the aim ray runs along -Z.
      space.rotateY(Math.PI);
      scene.updateMatrixWorld(true);
      pointer.move(scene, ev());
    },
    down: () => pointer.down(ev()),
    up: () => pointer.up(ev()),
    hit: () => pointer.getIntersection(),
  };
}

function place(o: Object3D, p: { pos: { x: number; y: number; z: number }; yaw: number; tilt: number }) {
  o.position.set(p.pos.x, p.pos.y, p.pos.z);
  o.rotation.set(p.tilt, p.yaw, 0, 'YXZ');
}

describe('panels with a controller', () => {
  it('controller_presses_round_bar_buttons_by_ray', () => {
    const actions: RoundAction[] = [];
    const bar = new RoundBar((a) => actions.push(a));
    const scene = new Scene();
    scene.add(bar.group);
    // In the room the panel's group is an interactable entity: it listens for pointers itself, which makes
    // everything under it (the hold ring too) something a ray can land on.
    bar.group.addEventListener('pointerenter' as never, () => {});
    place(bar.group, layoutDesk(DESK).roundBar);
    bar.setState({ status: 'live', elapsed_s: 5, total_s: 480, muted: false, captions: false });
    scene.updateMatrixWorld(true);
    const rig = rayRig(scene);
    // The controller is held in front of the chest, about 30 cm from the bar: every button is pressed from there.
    const from = new Vector3(DESK.head.x + 0.1, DESK.head.y - 0.25, DESK.head.z);
    const centre = (name: 'mute' | 'pause' | 'cc' | 'end') => (bar as unknown as Record<string, { root: Object3D }>)[name]!.root.getWorldPosition(new Vector3());
    rig.aim(from, from.clone().setY(from.y + 1));
    const press = (name: 'mute' | 'pause' | 'cc' | 'end') => {
      rig.aim(from, centre(name));
      expect(rig.hit()?.object.isVoidObject, `${name} is under the ray`).not.toBe(true);
      rig.down();
      rig.up();
    };
    press('pause');
    expect(actions).toEqual(['pause']);
    // Paused: the same button resumes.
    bar.setState({ status: 'paused', elapsed_s: 5, total_s: 480, muted: false, captions: false });
    press('pause');
    press('mute');
    press('cc');
    expect(actions).toEqual(['pause', 'resume', 'mute', 'captions']);
    // A slow, deliberate pull (the trigger held for two seconds before letting go) still presses.
    bar.setState({ status: 'live', elapsed_s: 5, total_s: 480, muted: false, captions: false });
    rig.aim(from, centre('pause'));
    rig.down();
    for (let i = 0; i < 144; i++) rig.aim(from, centre('pause'));
    rig.up();
    expect(actions.at(-1)).toBe('pause');
    // Sliding off the button before letting go cancels the press.
    rig.aim(from, centre('mute'));
    rig.down();
    rig.aim(from, from.clone().setY(from.y + 1));
    rig.up();
    expect(actions.at(-1)).toBe('pause');
    // End is a hold: the trigger held on it for a second, then let go. The ray stays on the button every frame
    // while the ring fills around it.
    rig.aim(from, centre('end'));
    bar.tick(0, 1000);
    rig.down();
    bar.tick(0.3, 1300);
    rig.aim(from, centre('end'));
    rig.up();
    expect(actions).not.toContain('end');
    bar.tick(0, 2000);
    rig.down();
    for (let t = 2000; t <= 2000 + END_HOLD_MS + 50; t += 14) {
      bar.tick(0.014, t);
      rig.aim(from, centre('end'));
    }
    rig.up();
    expect(actions.at(-1)).toBe('end');
    // A ray that is not on the bar presses nothing.
    const n = actions.length;
    rig.aim(from, new Vector3(from.x, from.y + 1, from.z - 1));
    rig.down();
    rig.up();
    expect(actions).toHaveLength(n);
  });

  it('the_ray_presses_the_buttons_on_the_status_and_summary_cards', () => {
    const ui = new RoundUI();
    const actions: RoundAction[] = [];
    ui.onAction((a) => actions.push(a));
    const scene = new Scene();
    const poses = layoutDesk(DESK);
    for (const k of ['status', 'summary'] as const) {
      scene.add(ui.groups[k]);
      place(ui.groups[k], poses[k]);
    }
    const rig = rayRig(scene);
    const from = new Vector3(DESK.head.x + 0.12, DESK.head.y - 0.3, DESK.head.z + 0.05);
    const pressEvery = (root: Object3D) => {
      // Every clickable thing on the card: aim at its centre and pull the trigger.
      rig.aim(from, from.clone().setY(from.y + 1));
      scene.updateMatrixWorld(true);
      const targets: Object3D[] = [];
      root.traverse((o) => {
        const p = (o as unknown as { properties?: { peek?(): { onPointerDown?: unknown; display?: string } } }).properties?.peek?.();
        if (p?.onPointerDown && p.display !== 'none') targets.push(o);
      });
      for (const t of targets) {
        rig.aim(from, t.getWorldPosition(new Vector3()));
        rig.down();
        rig.up();
      }
      return targets.length;
    };
    ui.setStatus('paused');
    expect(pressEvery(ui.groups.status)).toBeGreaterThanOrEqual(1);
    expect(actions).toContain('resume');
    ui.hideStatus();
    ui.showSummary({
      verdict: { label: 'Leaning hire', tone: 'mid', provisional: false },
      bars: [{ name: 'Clarity', score: 3 }],
      strength: 'Clear scoping',
      fix: 'Name the failure cases',
      canRetry: true,
    } as never);
    const n = pressEvery(ui.groups.summary);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(actions).toEqual(expect.arrayContaining(['retry', 'report']));
  });

  it('every_interruption_card_and_the_onboarding_skip_press_by_ray', () => {
    const ui = new RoundUI();
    const actions: RoundAction[] = [];
    ui.onAction((a) => actions.push(a));
    const scene = new Scene();
    scene.add(ui.groups.status);
    ui.groups.status.addEventListener('pointerenter' as never, () => {});
    place(ui.groups.status, layoutDesk(DESK).status);
    const rig = rayRig(scene);
    const from = new Vector3(DESK.head.x - 0.16, DESK.head.y - 0.28, DESK.head.z - 0.02);
    const pressAll = () => {
      rig.aim(from, from.clone().setY(from.y + 1));
      scene.updateMatrixWorld(true);
      const targets: Object3D[] = [];
      ui.groups.status.traverse((o) => {
        let shown = true;
        for (let q: Object3D | null = o; q && q !== ui.groups.status; q = q.parent) {
          if ((q as unknown as { properties?: { peek?(): { display?: string } } }).properties?.peek?.().display === 'none') shown = false;
        }
        const p = (o as unknown as { properties?: { peek?(): { onPointerDown?: unknown } } }).properties?.peek?.();
        if (p?.onPointerDown && shown) targets.push(o);
      });
      for (const t of targets) {
        rig.aim(from, t.getWorldPosition(new Vector3()));
        rig.down();
        // A slow pull: the trigger stays down for a second and a half.
        for (let i = 0; i < 100; i++) rig.aim(from, t.getWorldPosition(new Vector3()));
        rig.up();
      }
      return targets.length;
    };
    for (const kind of Object.keys(NOTICES) as NoticeKind[]) {
      actions.length = 0;
      ui.setNotice(kind);
      expect(pressAll(), kind).toBe(NOTICES[kind].actions.length);
      expect(actions, kind).toEqual(NOTICES[kind].actions);
    }
    // The onboarding line with its Skip button is the same card.
    ui.setNotice(null);
    actions.length = 0;
    ui.status.showText('Pull the trigger and draw a box', '', null, [{ label: 'Skip', action: 'skip' }]);
    expect(pressAll()).toBe(1);
    expect(actions).toEqual(['skip']);
  });

  it('the_placement_prompt_names_the_action_for_the_input_in_use', () => {
    expect(PLACING_COPY.hands.title).toBe('Touch your desk with one finger');
    expect(PLACING_COPY.controllers.title).toBe('Rest the tip on your desk');
    expect(PLACING_COPY.controllers.detail).toBe('Then pull the trigger.');
    expect(PLACING_MISSED_LINE).toBe('Rest the tip on the desk first');
    expect(STATUS_COPY.placing).toBe(PLACING_COPY.hands);
    const ui = new RoundUI();
    ui.showPlacing('controllers');
    expect(ui.status.group.visible).toBe(true);
    ui.showPlacing('hands');
    expect(ui.status.group.visible).toBe(true);
  });

  it('hint_never_says_put_controllers_down', () => {
    // Every line the app can show: no source file outside the tests tells the user to put controllers away.
    const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const files = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));
    expect(files.length).toBeGreaterThan(100);
    const banned = /controllers? (down|away|aside)|put (your|the) controllers|hands do everything/i;
    const hits = files.flatMap(([path, src]) =>
      src
        .split('\n')
        .map((line, i) => ({ path, line: line.trim(), n: i + 1 }))
        .filter((l) => banned.test(l.line) && !/^(\/\/|\/\*|\*)/.test(l.line)),
    );
    expect(hits).toEqual([]);
    // And the hint itself only ever shows what it is given: the one line the room has is the no-desk line.
    const ui = new RoundUI();
    ui.showHint('No desk? We set one up for you.', 0);
    expect(ui.hint.history.map((h) => h.line)).toEqual(['No desk? We set one up for you.']);
  });
});

// ---- a hand's poke: the fingertip is a small sphere that presses within 2 cm of a panel ----

import { createTouchPointer } from '@pmndrs/pointer-events';

/**
 * A fingertip as the room's pointer system drives it: a touch pointer on a space (hover 20 cm, down 2 cm). Every
 * frame is its own task, as in the browser: what the page queues during a frame runs before the next one.
 */
function pokeRig(scene: Scene) {
  const tip = new Object3D();
  scene.add(tip);
  const camera = new PerspectiveCamera();
  const pointer = createTouchPointer(() => camera, { current: tip }, {}, { hoverRadius: 0.2, downRadius: 0.02, clickThresholdMs: 800, button: 0 });
  let t = 0;
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    /** One frame with the fingertip at a world point. */
    async at(p: Vector3) {
      scene.traverse((o) => {
        if (o instanceof UIKitDocument) (o.rootElement as unknown as { update(dt: number): void }).update(1 / 72);
      });
      tip.position.copy(p);
      scene.updateMatrixWorld(true);
      pointer.move(scene, { timeStamp: (t += 14) });
      await settle();
    },
    /** Hand tracking drops for a frame: the room's input cancels the pointer and turns it off, as IWSDK does. */
    async trackingLost() {
      const e = { timeStamp: (t += 14) };
      pointer.cancel(e);
      pointer.setEnabled(false, e, true);
      await settle();
    },
    async trackingBack() {
      pointer.setEnabled(true, { timeStamp: (t += 14) }, false);
      await settle();
    },
    /** The room's input lets go of a touch whose target is gone (nothing real under the finger any more). */
    async forceRelease() {
      pointer.up({ timeStamp: (t += 14), button: 0 });
      await settle();
    },
    down: () => pointer.getButtonsDown().size > 0,
    hit: () => pointer.getIntersection()?.object ?? null,
  };
}

describe('panels with a hand poke', () => {
  async function barScene() {
    const actions: RoundAction[] = [];
    const bar = new RoundBar((a) => actions.push(a));
    const scene = new Scene();
    scene.add(bar.group);
    // As in the room: the panel's group is an interactable entity, so everything under it can take a pointer.
    bar.group.addEventListener('pointerenter' as never, () => {});
    place(bar.group, layoutDesk(DESK).roundBar);
    bar.setState({ status: 'live', elapsed_s: 5, total_s: 480, muted: false, captions: false });
    scene.updateMatrixWorld(true);
    const rig = pokeRig(scene);
    await rig.at(new Vector3(0, 2, 0));
    const normal = new Vector3(0, 0, 1).transformDirection(bar.group.matrixWorld);
    const along = new Vector3(1, 0, 0).transformDirection(bar.group.matrixWorld);
    const upPanel = new Vector3(0, 1, 0).transformDirection(bar.group.matrixWorld);
    type Name = 'mute' | 'pause' | 'cc' | 'end';
    const root = (name: Name) => (bar as unknown as Record<string, { root: Object3D }>)[name]!.root;
    const centre = (name: Name) => root(name).getWorldPosition(new Vector3());
    /** The fingertip `d` metres in front of a button (negative: pushed through it), `u` right and `v` up on the panel. */
    const over = (name: Name, d: number, u = 0, v = 0) => centre(name).addScaledVector(normal, d).addScaledVector(along, u).addScaledVector(upPanel, v);
    /** The finger comes straight in to 1 mm above the button, 5 mm a frame. */
    const press = async (name: Name, u = 0, v = 0) => {
      for (let d = 0.08; d > 0.001; d -= 0.005) await rig.at(over(name, d, u, v));
      await rig.at(over(name, 0.001, u, v));
      expect(rig.down(), `${name} pressed`).toBe(true);
    };
    return { actions, bar, scene, rig, over, press, root };
  }

  it('a_hand_poke_taps_pause_and_the_other_round_bar_buttons', async () => {
    const { actions, bar, rig, over, press } = await barScene();
    const poke = async (name: 'mute' | 'pause' | 'cc') => {
      await press(name);
      for (let d = 0.001; d <= 0.08; d += 0.005) await rig.at(over(name, d));
      expect(rig.down()).toBe(false);
    };
    await poke('pause');
    expect(actions).toEqual(['pause']);
    bar.setState({ status: 'paused', elapsed_s: 5, total_s: 480, muted: false, captions: false });
    await poke('pause');
    await poke('mute');
    await poke('cc');
    expect(actions).toEqual(['pause', 'resume', 'mute', 'captions']);
    // A slow poke (the finger rests on the button for two seconds) still presses.
    bar.setState({ status: 'live', elapsed_s: 5, total_s: 480, muted: false, captions: false });
    await press('pause');
    for (let i = 0; i < 144; i++) await rig.at(over('pause', 0.001));
    for (let d = 0.001; d <= 0.06; d += 0.005) await rig.at(over('pause', d));
    expect(actions.at(-1)).toBe('pause');
  });

  it('a_finger_that_pushes_through_a_button_and_comes_back_presses_it_once', async () => {
    const { actions, rig, over, press } = await barScene();
    await press('mute');
    // On through the panel to 4 cm behind it, then back out the front.
    for (let d = -0.004; d >= -0.04; d -= 0.005) await rig.at(over('mute', d));
    for (let d = -0.04; d <= 0.08; d += 0.005) await rig.at(over('mute', d));
    expect(rig.down()).toBe(false);
    expect(actions).toEqual(['mute']);
    // A press that only ever comes from behind presses nothing; the next poke from the front still does.
    for (let d = -0.08; d <= 0.08; d += 0.005) await rig.at(over('cc', d));
    expect(actions).toEqual(['mute']);
    await press('cc');
    for (let d = 0.001; d <= 0.08; d += 0.005) await rig.at(over('cc', d));
    expect(actions).toEqual(['mute', 'captions']);
  });

  it('a_finger_that_slides_off_a_button_along_the_panel_presses_nothing', async () => {
    const { actions, rig, over, press } = await barScene();
    // Down on Mute, then 3 mm above the panel all the way: off Mute's top edge and on over the bare panel, where
    // it finally lifts.
    await press('mute');
    for (let v = 0; v <= 0.03; v += 0.003) await rig.at(over('mute', 0.003, 0, v));
    expect(rig.down()).toBe(true);
    for (let d = 0.003; d <= 0.08; d += 0.005) await rig.at(over('mute', d, 0, 0.03));
    expect(rig.down()).toBe(false);
    expect(actions).toEqual([]);
  });

  it('a_fingertip_that_lifts_in_one_frame_past_the_button_edge_still_presses', async () => {
    // At a few frames a second (the headset emulator) the finger is on the button in one frame and well clear in
    // the next. Lifted from near Pause's top edge, 3 cm out and 2 cm further up the panel, the nearest thing under
    // it is the panel, not the button: the button is told the pointer left and the release goes to the panel.
    const { actions, rig, over, press, root } = await barScene();
    await press('pause', 0, 0.018);
    await rig.at(over('pause', 0.03, 0, 0.04));
    expect(rig.down()).toBe(false);
    expect(rig.hit()).not.toBe(root('pause'));
    expect(actions).toEqual(['pause']);
  });

  it('a_tracking_drop_or_a_panel_that_goes_away_under_a_resting_finger_presses_nothing', async () => {
    const { actions, bar, scene, rig, over, press } = await barScene();
    // A fingertip rests on Mute while the user decides; hand tracking drops for a frame.
    await press('mute');
    await rig.trackingLost();
    expect(rig.down()).toBe(false);
    expect(actions).toEqual([]);
    // Tracking comes back with the finger still there, and it lifts: still nothing (the press was let go).
    await rig.trackingBack();
    for (let d = 0.03; d <= 0.08; d += 0.005) await rig.at(over('mute', d));
    expect(actions).toEqual([]);
    // A fingertip rests on Pause and the bar goes away under it (the round is over): the release is not a press.
    await press('pause');
    scene.remove(bar.group);
    await rig.at(over('pause', 0.001));
    await rig.forceRelease();
    expect(actions).toEqual([]);
    // A proper poke after all that still works.
    scene.add(bar.group);
    await rig.at(over('cc', 0.1));
    await press('cc');
    for (let d = 0.001; d <= 0.08; d += 0.005) await rig.at(over('cc', d));
    expect(actions).toEqual(['captions']);
  });

  it('a_hand_poke_holds_end_until_the_ring_is_full', async () => {
    const { actions, bar, rig, over } = await barScene();
    // The finger arrives, the press starts 2 cm out, and it keeps coming: the ring that shows around End must not
    // take the fingertip from the button.
    let now = 1000;
    const frame = async (d: number) => {
      now += 14;
      bar.tick(0.014, now);
      await rig.at(over('end', d));
    };
    for (let d = 0.08; d >= 0.002; d -= 0.004) await frame(d);
    expect(rig.down()).toBe(true);
    // Resting on End for 0.4 s and lifting: not an End.
    for (let i = 0; i < 28; i++) await frame(0.002);
    for (let d = 0.002; d <= 0.08; d += 0.005) await frame(d);
    expect(actions).not.toContain('end');
    // A full hold cut short by a tracking drop: not an End either.
    for (let d = 0.08; d >= 0.002; d -= 0.004) await frame(d);
    for (let i = 0; i < 20; i++) await frame(0.002);
    await rig.trackingLost();
    await rig.trackingBack();
    expect(actions).not.toContain('end');
    for (let d = 0.03; d <= 0.08; d += 0.005) await frame(d);
    // Again, held for the full second (and a little), then lifted: End.
    for (let d = 0.08; d >= 0.002; d -= 0.004) await frame(d);
    for (let i = 0; i < Math.ceil((END_HOLD_MS + 100) / 14); i++) await frame(0.002 + 0.002 * Math.sin(i / 5));
    expect(actions).not.toContain('end');
    for (let d = 0.002; d <= 0.08; d += 0.005) await frame(d);
    expect(actions.at(-1)).toBe('end');
  });

  it('a_hand_poke_presses_the_paused_card_buttons', async () => {
    const ui = new RoundUI();
    const actions: RoundAction[] = [];
    ui.onAction((a) => actions.push(a));
    const scene = new Scene();
    scene.add(ui.groups.status);
    ui.groups.status.addEventListener('pointerenter' as never, () => {});
    place(ui.groups.status, layoutDesk(DESK).status);
    ui.setNotice('paused');
    const rig = pokeRig(scene);
    await rig.at(new Vector3(0, 3, 0));
    scene.updateMatrixWorld(true);
    const normal = new Vector3(0, 0, 1).transformDirection(ui.groups.status.matrixWorld);
    const targets: Object3D[] = [];
    ui.groups.status.traverse((o) => {
      const p = (o as unknown as { properties?: { peek?(): { onPointerDown?: unknown } } }).properties?.peek?.();
      if (p?.onPointerDown) targets.push(o);
    });
    expect(targets).toHaveLength(2);
    for (const t of targets) {
      const c = t.getWorldPosition(new Vector3());
      for (let d = 0.08; d >= -0.003; d -= 0.005) await rig.at(c.clone().addScaledVector(normal, d));
      for (let d = -0.003; d <= 0.08; d += 0.005) await rig.at(c.clone().addScaledVector(normal, d));
    }
    expect(actions).toEqual(['resume', 'end']);
  });

  it('a_press_belongs_to_the_pointer_that_made_it', () => {
    const clicks: string[] = [];
    const b = button('Pause', { onClick: () => clicks.push('click'), onLeave: () => clicks.push('leave') });
    const h = (b.root as unknown as { properties: { peek(): Record<string, (e: object) => void> } }).properties.peek();
    // A ray that leaves the button with the trigger still held is a slide: no press, and its later release is nothing.
    h.onPointerDown!({ pointerId: 77, pointerType: 'ray', button: 0 });
    h.onPointerLeave!({ pointerId: 77, pointerType: 'ray' });
    h.onPointerUp!({ pointerId: 77, pointerType: 'ray', button: 0 });
    expect(clicks).toEqual(['leave']);
    // Another pointer crossing the button neither cancels nor completes a press, and a right button presses nothing.
    h.onPointerDown!({ pointerId: 5, pointerType: 'ray', button: 0 });
    h.onPointerLeave!({ pointerId: 6, pointerType: 'ray' });
    h.onPointerUp!({ pointerId: 6, pointerType: 'ray', button: 0 });
    expect(clicks).toEqual(['leave']);
    h.onPointerUp!({ pointerId: 5, pointerType: 'ray', button: 0 });
    expect(clicks).toEqual(['leave', 'click']);
    h.onPointerDown!({ pointerId: 5, pointerType: 'screen-mouse', button: 2 });
    h.onPointerUp!({ pointerId: 5, pointerType: 'screen-mouse', button: 2 });
    expect(clicks).toEqual(['leave', 'click']);
  });
});
