import { describe, expect, it } from 'vitest';
import { EchoCounter } from './echoCounter';

/** Feeds levels every 50 ms from a to b. */
function levels(c: EchoCounter, a: number, b: number, mic: (t: number) => number, agent: (t: number) => number) {
  for (let t = a; t < b; t += 50) {
    c.micLevel(mic(t), t);
    c.agentLevel(agent(t), t);
  }
}

describe('EchoCounter', () => {
  it('a clean run: no false triggers, a fast stop when talked over', () => {
    const c = new EchoCounter(0, 10000, 5000);
    c.connected(800);
    c.mode('speaking', 1500);
    expect(c.phase).toBe('silent');
    levels(c, 1500, 11500, () => -70, () => -20);
    expect(c.phase).toBe('silent');
    // Silent until 12 s, then the tester talks; the agent stops 400 ms later and its audio goes quiet.
    levels(c, 11500, 12000, () => -70, () => -20);
    expect(c.phase).toBe('barge');
    levels(c, 12000, 12400, () => -25, () => -20);
    c.user('u1', 'sorry can I', false, 12350);
    c.mode('listening', 12450);
    levels(c, 12450, 15000, () => -25, () => -80);
    expect(c.phase).toBe('done');
    const r = c.results(15000);
    expect(r.connect_ms).toBe(800);
    expect(r.first_speech_ms).toBe(1500);
    expect(r.silent).toMatchObject({ user_segments: 0, user_finals: 0, agent_interruptions: 0 });
    expect(r.silent.ms).toBe(10000);
    expect(r.silent.mic!.p95_db).toBe(-70);
    expect(r.silent.agent!.p50_db).toBe(-20);
    expect(r.barge.onset_source).toBe('mic');
    expect(r.barge.onset_ms).toBe(550);
    expect(r.barge.agent_stopped).toBe(true);
    expect(r.barge.stop_after_onset_ms).toBe(400);
    expect(r.barge.audio_stop_after_onset_ms).toBe(400);
    expect(r.barge.user_texts).toEqual(['sorry can I']);
  });

  it('echo shows as user segments and interruptions while the tester is silent', () => {
    const c = new EchoCounter(0, 10000, 5000);
    c.mode('speaking', 1000);
    c.agentText(1100);
    c.user('a', 'the old', false, 3000);
    c.user('a', 'the old harbour', true, 3500);
    c.mode('listening', 3600);
    c.mode('speaking', 4500);
    c.user('b', 'bread', false, 6000);
    const r = c.results(8000);
    expect(r.silent.user_segments).toBe(2);
    expect(r.silent.user_finals).toBe(1);
    expect(r.silent.user_texts).toEqual(['the old harbour', 'bread']);
    expect(r.silent.agent_interruptions).toBe(1);
    expect(c.phase).toBe('silent');
  });

  it('without mic levels the first transcript is the onset; a stop before it is negative', () => {
    const c = new EchoCounter(0, 1000, 5000);
    c.mode('speaking', 0);
    c.tick(1000);
    expect(c.phase).toBe('barge');
    c.mode('listening', 1800);
    c.user('x', 'wait', false, 2100);
    const r = c.results(3000);
    expect(r.barge.onset_source).toBe('transcript');
    expect(r.barge.onset_ms).toBe(1100);
    expect(r.barge.stop_after_onset_ms).toBe(-300);
    expect(r.barge.audio_stop_after_onset_ms).toBeNull();
  });

  it('an agent that never stops is reported as not stopped', () => {
    const c = new EchoCounter(0, 1000, 3000);
    c.mode('speaking', 0);
    levels(c, 0, 1000, () => -70, () => -20);
    levels(c, 1000, 4100, () => -20, () => -20);
    expect(c.phase).toBe('done');
    const r = c.results(4100);
    expect(r.barge.onset_source).toBe('mic');
    expect(r.barge.agent_stopped).toBe(false);
    expect(r.barge.stop_after_onset_ms).toBeNull();
  });

  it('sentence pauses in the agent audio are not a stop', () => {
    const c = new EchoCounter(0, 1000, 5000);
    c.mode('speaking', 0);
    levels(c, 0, 1000, () => -70, () => -20);
    levels(c, 1000, 1200, () => -20, () => -20);
    // 300 ms pause, then speech again.
    levels(c, 1200, 1500, () => -20, () => -80);
    levels(c, 1500, 2000, () => -20, () => -20);
    expect(c.results(2000).barge.audio_stop_after_onset_ms).toBeNull();
  });

  it('never speaking leaves it waiting', () => {
    const c = new EchoCounter(0);
    c.tick(60000);
    expect(c.phase).toBe('waiting');
    expect(c.results(60000).first_speech_ms).toBeNull();
    expect(c.remainingMs(60000)).toBe(0);
  });

  it('remaining time counts down per part', () => {
    const c = new EchoCounter(0, 10000, 5000);
    c.mode('speaking', 1000);
    expect(c.remainingMs(4000)).toBe(7000);
    c.tick(11000);
    expect(c.remainingMs(12000)).toBe(4000);
  });

  it('the spoken cue ends the silent part, even before 45 s, so obeying it is never echo', () => {
    const c = new EchoCounter(0);
    c.mode('speaking', 0);
    c.agentText(1000, 'This is a sound check');
    c.user('echo', 'the old', true, 10000);
    c.agentText(40000, 'This is a sound check ... above the lighthouse. Now please talk over me');
    expect(c.phase).toBe('barge');
    c.user('t', 'sorry can I jump in', false, 40600);
    c.mode('listening', 41000);
    const r = c.results(42000);
    expect(r.barge.started_by).toBe('cue');
    expect(r.silent.user_segments).toBe(1);
    expect(r.silent.user_texts).toEqual(['the old']);
    expect(r.silent.ms).toBe(40000);
    expect(r.barge.user_texts).toEqual(['sorry can I jump in']);
    expect(r.barge.onset_source).toBe('transcript');
    expect(r.barge.agent_stopped).toBe(true);
    expect(r.barge.stop_after_onset_ms).toBe(400);
  });

  it('speech starting just before the cue counts as the tester reacting', () => {
    const c = new EchoCounter(0);
    c.mode('speaking', 0);
    c.agentText(500, 'This is');
    c.user('t', 'sorry', false, 39200);
    c.agentText(40000, 'Now please talk over me');
    const r = c.results(40500);
    expect(r.silent.user_segments).toBe(0);
    expect(r.barge.user_texts).toEqual(['sorry']);
    expect(r.barge.onset_ms).toBe(-800);
  });

  it('with her words but no cue the silent part waits for the long fallback', () => {
    const c = new EchoCounter(0);
    c.mode('speaking', 0);
    c.agentText(500, 'This is a sound check');
    c.tick(46000);
    expect(c.phase).toBe('silent');
    c.tick(75000);
    expect(c.phase).toBe('barge');
    expect(c.results(75000).barge.started_by).toBe('timer');
  });

  it('a stop with nobody talking over her is not a barge-in', () => {
    const c = new EchoCounter(0, 45000, 15000);
    c.mode('speaking', 0);
    c.agentText(40000, 'Now please talk over me');
    c.mode('listening', 50000);
    const r = c.results(52000);
    expect(r.barge.agent_stopped).toBe(false);
    expect(r.barge.stopped_on_its_own).toBe(true);
    expect(r.barge.stop_after_onset_ms).toBeNull();
  });

  it('a pause before the tester talks is kept apart from the stop that answers them', () => {
    const c = new EchoCounter(0, 1000, 10000);
    c.mode('speaking', 0);
    c.tick(1000);
    c.mode('listening', 2000);
    c.mode('speaking', 2300);
    c.user('t', 'wait', false, 6000);
    c.mode('listening', 6300);
    const r = c.results(7000);
    expect(r.barge.stop_after_onset_ms).toBe(300);
    expect(r.barge.stopped_on_its_own).toBe(true);
  });
});
