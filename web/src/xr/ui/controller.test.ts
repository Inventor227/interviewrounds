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
import { PLACING_COPY, STATUS_COPY } from './statusCard';
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
    expect(PLACING_COPY.controllers.title).toBe('Touch your desk with the controller tip and pull the trigger');
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
