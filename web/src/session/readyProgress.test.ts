import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBytes, knownSize, resetBytes, versioned } from '../net/bytes';
import { clearReady, readyPeople, readyState, readyStep, readyView, startReady } from './readyProgress';

afterEach(() => {
  clearReady();
  resetBytes();
  vi.unstubAllGlobals();
});

describe('readyProgress', () => {
  it('nothing_before_a_prepare', () => {
    expect(readyState()).toBeNull();
    expect(readyView()).toEqual({ step: 'setup', label: 'Setting up your round', fraction: null });
  });

  it('steps_move_the_line_and_the_bar_forward', () => {
    startReady();
    const a = readyView();
    expect(a.label).toBe('Setting up your round');
    readyStep('room');
    const b = readyView();
    expect(b.label).toBe('Building the room');
    expect(b.fraction!).toBeGreaterThan(a.fraction!);
  });

  it('people_step_names_who_is_coming_and_is_indeterminate_until_files_are_known', () => {
    startReady();
    readyPeople(['Daniel'], []);
    expect(readyView()).toEqual({ step: 'people', label: 'Bringing in Daniel', fraction: null });
    readyPeople(['Daniel', 'Maya'], []);
    expect(readyView().label).toBe('Bringing in Daniel and Maya');
    readyPeople([], []);
    expect(readyView().label).toBe('Bringing in your panel');
  });

  it('people_bar_follows_the_bytes_then_says_almost_ready', async () => {
    const glb = versioned('/avatars/m02.glb');
    const anims = versioned('/avatars/anims-m.glb');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', async (url: string) => {
      const n = knownSize(url)!;
      if (url === glb) await gate;
      return new Response(new Uint8Array(n));
    });
    startReady();
    readyStep('room');
    const room = readyView().fraction!;
    readyPeople(['Daniel'], [glb, anims]);
    const start = readyView();
    expect(start.step).toBe('people');
    expect(start.fraction!).toBeGreaterThan(room);

    const p1 = fetchBytes(anims);
    const p2 = fetchBytes(glb);
    await p1;
    const mid = readyView();
    expect(mid.label).toBe('Bringing in Daniel');
    expect(mid.fraction!).toBeGreaterThan(start.fraction!);
    expect(mid.fraction!).toBeLessThan(0.95);
    release();
    await p2;
    expect(readyView()).toMatchObject({ step: 'almost', label: 'Almost ready' });
  });

  it('copy_has_no_dashes', () => {
    startReady();
    const lines = [readyView().label];
    readyStep('room');
    lines.push(readyView().label);
    readyPeople(['Daniel', 'Maya', 'Leo'], []);
    lines.push(readyView().label);
    // tools/check-copy.mjs checks written copy for dashes; these lines are made at run time.
    expect(lines.join(' ').split('').some((c) => c.charCodeAt(0) === 0x2013 || c.charCodeAt(0) === 0x2014)).toBe(false);
    expect(lines[2]).toBe('Bringing in Daniel, Maya and Leo');
  });
});
