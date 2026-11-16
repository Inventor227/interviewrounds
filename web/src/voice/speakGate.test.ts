import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVEL_POLL_MS, SPEAK_SHOW_MS, speakGate } from './speakGate';
import { ScriptedTransport } from './testkit';

function watch() {
  const t = new ScriptedTransport('p1');
  const gate = speakGate(t);
  const shows: number[] = [];
  const texts: string[] = [];
  gate.on('show', () => shows.push(Date.now()));
  gate.on('text', (e) => texts.push(e.text));
  return { t, gate, shows, texts };
}

describe('speakGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('a reply stopped within milliseconds is never shown, nor are its late words', () => {
    const { t, shows, texts } = watch();
    t.mode('thinking');
    t.mode('speaking');
    t.agent('s1', 'Okay.');
    vi.advanceTimersByTime(5);
    t.mode('listening');
    vi.advanceTimersByTime(1_000);
    t.agent('s1', 'Okay.'); // a late copy of the same reply
    expect(shows).toEqual([]);
    expect(texts).toEqual([]);
  });

  it('a silent-level reply that keeps speaking is shown after SPEAK_SHOW_MS with its latest words', () => {
    const { t, gate, shows, texts } = watch();
    t.mode('speaking');
    t.agent('s1', 'Got', 'Got');
    vi.advanceTimersByTime(100);
    t.agent('s1', ' it.', 'Got it.');
    vi.advanceTimersByTime(SPEAK_SHOW_MS - 101);
    expect(shows).toEqual([]);
    expect(texts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shows).toEqual([SPEAK_SHOW_MS]);
    expect(texts).toEqual(['Got it.']);
    expect(gate.isShown).toBe(true);
    // Once shown, words pass at once.
    t.agent('s1', ' What', 'Got it. What');
    expect(texts).toEqual(['Got it.', 'Got it. What']);
  });

  it('an audible reply is shown as soon as its level rises', () => {
    const { t, shows, texts } = watch();
    t.mode('speaking');
    t.agent('s1', 'Right.');
    vi.advanceTimersByTime(40);
    t.level = 0.12;
    vi.advanceTimersByTime(LEVEL_POLL_MS);
    expect(shows.length).toBe(1);
    expect(shows[0]).toBeLessThanOrEqual(40 + LEVEL_POLL_MS);
    expect(texts).toEqual(['Right.']);
  });

  it('a fragment does not hold back the next real reply', () => {
    const { t, shows, texts } = watch();
    t.mode('speaking');
    t.agent('s1', 'Mm-hm.');
    t.mode('listening');
    t.mode('thinking');
    t.mode('speaking');
    t.agent('s2', 'Got it. What happened next?');
    vi.advanceTimersByTime(SPEAK_SHOW_MS);
    expect(shows.length).toBe(1);
    expect(texts).toEqual(['Got it. What happened next?']);
  });

  it('a voice that ends before its reply is audible shows nothing', () => {
    const { t, shows, texts } = watch();
    t.mode('speaking');
    t.agent('s1', 'So');
    t.events.emit('ended', { reason: 'server' });
    vi.advanceTimersByTime(1_000);
    expect(shows).toEqual([]);
    expect(texts).toEqual([]);
  });

  it('text without a speaking mode (no gate open) is shown as it comes', () => {
    const { t, texts } = watch();
    t.agent('s1', 'Hello there.');
    expect(texts).toEqual(['Hello there.']);
  });

  it('every listener of a transport sees the same gate', () => {
    const t = new ScriptedTransport('p1');
    expect(speakGate(t)).toBe(speakGate(t));
  });
});
