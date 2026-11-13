// Helpers for driving held controllers in the emulator (xr-input.mjs, round-controllers.mjs, round-switch.mjs).
// A controller's device pose is its aim ray: the position is the controller's front tip, -Z is where it points.
// The trigger is the select value; A or X is button 3 and the thumbstick axes 0 and 1 in the emulator's tooling
// (the app reads the xr-standard gamepad, where they are button 4 and axes 2 and 3).

import path from 'node:path';
import { execFile } from 'node:child_process';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { sleep } from './emu-lib.mjs';

const BIN = path.join(process.env.EMU_APP_DIR, 'node_modules/.bin/iwsdk');

/** xr <action> with the real error text. */
export function xr(action, input) {
  return new Promise((resolve, reject) => {
    execFile(BIN, ['xr', action, '--input-json', JSON.stringify(input)], { cwd: process.env.EMU_APP_DIR, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      let out = stdout;
      try {
        out = JSON.parse(stdout);
      } catch {}
      if (err) return reject(new Error(`xr ${action} failed (exit ${err.code}): ${String(stderr || stdout).slice(-3000)}`));
      resolve(out);
    });
  });
}

const r5 = (n) => Math.round(n * 1e5) / 1e5;
export const v = (p) => ({ x: r5(p.x), y: r5(p.y), z: r5(p.z) });

/** The orientation that points a device's -Z from `from` at `to`. */
export function aimQuat(from, to) {
  const d = new Vector3(to.x - from.x, to.y - from.y, to.z - from.z).normalize();
  const up = Math.abs(d.y) > 0.95 ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(new Vector3(0, 0, 0), d, up));
  return { x: r5(q.x), y: r5(q.y), z: r5(q.z), w: r5(q.w) };
}

export const dev = (hand) => `controller-${hand}`;

/** Puts a controller's tip at `tip`, aimed at `target`, at once. */
export const hold = (hand, tip, target) => xr('set-transform', { device: dev(hand), position: v(tip), orientation: aimQuat(tip, target) });

/** Moves a controller to a tip and aim over `duration` seconds. */
export const glide = (hand, tip, target, duration = 0.12) => xr('animate-to', { device: dev(hand), position: v(tip), orientation: aimQuat(tip, target), duration });

export const trigger = (hand, value) => xr('set-select-value', { device: dev(hand), value });

/** A full trigger pull held for `seconds`. */
export async function pull(hand, seconds = 0.2) {
  await trigger(hand, 1);
  await sleep(seconds * 1000);
  await trigger(hand, 0);
}

/** A or X (primary) or B or Y: down, then up. */
export async function pressButton(hand, which = 'primary') {
  const index = which === 'primary' ? 3 : 4;
  await xr('set-gamepad-state', { device: dev(hand), buttons: [{ index, value: 1 }] });
  await sleep(400);
  await xr('set-gamepad-state', { device: dev(hand), buttons: [{ index, value: 0 }] });
}

/** A point `d` metres straight below and a little ahead of a tip: where a controller resting its tip on a surface aims. */
export const below = (tip, d = 0.2) => ({ x: tip.x, y: tip.y - d, z: tip.z - d * 0.6 });

/**
 * A stroke with the trigger held. near: the tip travels 4 mm above the board points; far: the controller stays at
 * `from` and its ray sweeps the points. `tips` and `targets` are world points (the same length for near).
 */
export async function stroke(hand, { from = null, points }, segment = 0.12) {
  const pose = (p) => (from ? [from, p] : [p, below(p)]);
  await hold(hand, ...pose(points[0]));
  await sleep(700);
  await trigger(hand, 1);
  await sleep(350);
  for (const p of points.slice(1)) await glide(hand, ...pose(p), segment);
  await sleep(400);
  await trigger(hand, 0);
  await sleep(300);
}

/** Aims the ray at a world point from `from`, waits for the hover, and pulls the trigger for `seconds`. */
export async function rayPress(hand, from, target, seconds = 0.25) {
  await hold(hand, from, target);
  await sleep(900);
  await pull(hand, seconds);
  await sleep(300);
}
