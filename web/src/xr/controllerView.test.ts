import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControllerView, HOSTED_MODEL_DIR, HOSTED_PROFILES, hostedModelUrls, TIP_DOT_R } from './controllerView';

describe('controller visuals', () => {
  it('the_controller_model_is_served_from_this_origin_for_every_meta_controller', () => {
    const urls = hostedModelUrls('/');
    expect(urls).toHaveLength(HOSTED_PROFILES.length * 2);
    for (const u of urls) {
      // The platform's own address for the model is on another origin; ours is not.
      expect(u.from).toMatch(/^https:\/\/cdn\.jsdelivr\.net\//);
      expect(u.to).toMatch(/^\/vendor\/input-profiles\/meta-quest-touch-plus\/(left|right)\.glb$/);
    }
    expect(urls.map((u) => u.from)).toContain('https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/meta-quest-touch-plus/right.glb');
    for (const side of ['left', 'right']) {
      const f = resolve(process.cwd(), 'public', HOSTED_MODEL_DIR, `${side}.glb`);
      expect(existsSync(f), f).toBe(true);
      expect(statSync(f).size).toBeGreaterThan(50_000);
      expect(statSync(f).size).toBeLessThan(400_000);
    }
  });

  it('shows_only_while_a_controller_is_the_input_and_the_stand_in_only_without_a_model', () => {
    const v = new ControllerView('right');
    expect(v.group.visible).toBe(false);
    // A controller with the platform's model on screen: the tip dot only.
    v.set(true, true);
    expect(v.group.visible).toBe(true);
    expect(v.tip.visible).toBe(true);
    expect(v.body.visible).toBe(false);
    // No model came up: the plain stand-in body is drawn.
    v.set(true, false);
    expect(v.body.visible).toBe(true);
    // Hands take over: everything of the controller goes.
    v.set(false, false);
    expect(v.group.visible).toBe(false);
    expect(v.body.visible).toBe(false);
    // The tip dot is small and sits at the aim ray's origin (the controller's front).
    expect(TIP_DOT_R).toBeLessThanOrEqual(0.004);
    expect(v.tip.position.length()).toBe(0);
    v.dispose();
  });
});
