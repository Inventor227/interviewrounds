import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSessionInit, SessionMode } from '@iwsdk/core';
import { describe, expect, it } from 'vitest';
import { XR_FEATURES } from './sessionFeatures';

describe('session features', () => {
  it('a_session_can_start_with_hand_tracking_off_nothing_is_required', () => {
    const init = buildSessionInit({ sessionMode: SessionMode.ImmersiveAR, features: { ...XR_FEATURES } } as never);
    expect(init.requiredFeatures).toEqual([]);
    expect(init.optionalFeatures).toEqual(expect.arrayContaining(['hand-tracking', 'hit-test', 'anchors', 'local-floor']));
  });

  it('the_project_config_and_every_source_file_ask_for_nothing_required', () => {
    const cfg = JSON.parse(readFileSync(resolve(process.cwd(), 'iwsdk.config.json'), 'utf8')) as { world: { xr: { mode: string; features: Record<string, unknown> } } };
    const init = buildSessionInit({ sessionMode: SessionMode.ImmersiveAR, features: cfg.world.xr.features } as never);
    expect(init.requiredFeatures).toEqual([]);
    expect(init.optionalFeatures).toContain('hand-tracking');
    // No plane or mesh detection: they would add a permission prompt.
    expect(init.optionalFeatures).not.toContain('plane-detection');
    expect(init.optionalFeatures).not.toContain('mesh-detection');
    const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const hits = Object.entries(sources)
      .filter(([path]) => !/\.test\.tsx?$/.test(path))
      .filter(([, src]) => /required:\s*true/.test(src) || /requiredFeatures/.test(src))
      .map(([path]) => path);
    expect(hits).toEqual([]);
  });
});
