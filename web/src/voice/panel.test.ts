import { describe, expect, it, vi } from 'vitest';
import type { Panelist } from '../shared/types';
import { OLD_VOICE_TAIL_MS, PanelController } from './panel';
import { panelist, ScriptedTransport, sessionRes } from './testkit';
import type { TransportOptions, VoiceTransport } from './transport';

/** A transport whose start() waits until the test releases it (or fails it). */
class SlowTransport extends ScriptedTransport {
  release!: () => void;
  fail!: (e: Error) => void;
  override async start(): Promise<void> {
    this.started = true;
    await new Promise<void>((res, rej) => {
      this.release = res;
      this.fail = rej;
    });
  }
}

/** The outgoing voice's sentence: waitQuiet() holds until quiet(), and resolves at once after it. */
function sentence() {
  let done = false;
  const waiters: (() => void)[] = [];
  const waitQuiet = vi.fn((_t: VoiceTransport) => (done ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))));
  const quiet = () => {
    done = true;
    for (const r of waiters.splice(0)) r();
  };
  return { waitQuiet, quiet };
}

function setup(
  mode: 'swap' | 'joined',
  panel = [panelist('p1', 0), panelist('p2', 1)],
  opts: { slow?: string[]; waitQuiet?: (t: VoiceTransport, expectSpeech?: boolean) => Promise<void>; ready?: () => Promise<void>; tailMs?: number } = {},
) {
  const log: string[] = [];
  const made: ScriptedTransport[] = [];
  const make = (p: Panelist, o?: TransportOptions) => {
    log.push(`make:${p.panelist_id}`);
    const T = opts.slow?.includes(p.panelist_id) ? SlowTransport : ScriptedTransport;
    const t = new T(p.panelist_id, log, o, p);
    made.push(t);
    return t;
  };
  const joinPanelist = vi.fn(async (_s: string, pid: string, body?: { opening_line?: string; deferred?: boolean; from?: string }) => {
    log.push(`join:${pid}${body?.deferred ? `:deferred:${body.from}` : ''}`);
    return { voice: { transport: 'fake' as const } };
  });
  const res = sessionRes({ panel_mode: mode, panel });
  const pc = new PanelController(res, make, { api: { joinPanelist }, waitQuiet: opts.waitQuiet, ready: opts.ready, tailMs: opts.tailMs ?? 0 });
  return { pc, log, made, joinPanelist };
}

describe('PanelController', () => {
  it('swap_handover_starts_new_before_stopping_old', async () => {
    const { pc, log, made, joinPanelist } = setup('swap');
    await pc.start();
    expect(made.map((t) => t.panelistId)).toEqual(['p1']);
    expect(made[0]!.muted).toBe(false);
    log.length = 0;

    await pc.handOver('p2');

    // Joined ahead of time, silent: the server keeps the line for the marker.
    expect(joinPanelist).toHaveBeenCalledWith('sess1', 'p2', { deferred: true, from: 'p1' });
    const iJoin = log.indexOf('join:p2:deferred:p1');
    const iStart = log.indexOf('start:p2');
    const iMarker = log.indexOf('event:p2:[event: handover]');
    const iStop = log.indexOf('stop:p1');
    expect(iJoin).toBeGreaterThanOrEqual(0);
    expect(iJoin).toBeLessThan(iStart);
    expect(iStart).toBeLessThan(iMarker);
    expect(iMarker).toBeLessThan(iStop);
    // Never two mics live: the old floor is muted before the join, the new one starts muted and opens after its marker.
    expect(log.indexOf('mute:p1')).toBeLessThan(iJoin);
    expect(log.indexOf('mute:p2')).toBeGreaterThan(-1);
    expect(log.indexOf('mute:p2')).toBeLessThan(iStart);
    expect(log.indexOf('unmute:p2')).toBeGreaterThan(iMarker);
    expect(made[1]!.sentEvents).toEqual(['[event: handover]']);
    expect(made[1]!.opts).toEqual({});
    expect(made[1]!.muted).toBe(false);
    expect(pc.floor).toBe('p2');
    expect(pc.current()?.panelistId).toBe('p2');
  });

  it('joined_handover_moves_mic_and_sends_event', async () => {
    const { pc, made, joinPanelist } = setup('joined');
    await pc.start();
    const [p1, p2] = made;
    expect(made).toHaveLength(2);
    expect(p1!.muted).toBe(false);
    expect(p2!.muted).toBe(true);

    await pc.handOver('p2');

    expect(joinPanelist).not.toHaveBeenCalled();
    expect(p1!.muted).toBe(true);
    expect(p2!.muted).toBe(false);
    expect(p2!.sentEvents).toEqual(['[event: handover]']);
    expect(p1!.stopped).toBe(false);
    expect(pc.floor).toBe('p2');
  });

  it('joined_start_resolves_pending_voices', async () => {
    const { pc, joinPanelist, made } = setup('joined', [
      panelist('p1', 0),
      panelist('p2', 1, { transport: 'fish_pending' }),
    ]);
    await pc.start();
    expect(joinPanelist).toHaveBeenCalledWith('sess1', 'p2', {});
    expect(made[1]!.panelist?.voice).toEqual({ transport: 'fake' });
  });

  it('mute_all_restores_floor_gating', async () => {
    const { pc, made } = setup('joined');
    await pc.start();
    pc.muteAll(true);
    expect(made.every((t) => t.muted)).toBe(true);
    pc.muteAll(false);
    expect(made[0]!.muted).toBe(false);
    expect(made[1]!.muted).toBe(true);
  });

  it('handover_to_current_floor_is_a_no_op', async () => {
    const { pc, made, joinPanelist } = setup('swap');
    await pc.start();
    await pc.handOver('p1');
    expect(joinPanelist).not.toHaveBeenCalled();
    expect(made).toHaveLength(1);
  });

  it('failed_swap_keeps_the_old_floor', async () => {
    const { pc, made, joinPanelist } = setup('swap');
    await pc.start();
    joinPanelist.mockRejectedValueOnce(new Error('nope'));
    await expect(pc.handOver('p2')).rejects.toThrow('nope');
    expect(pc.floor).toBe('p1');
    expect(pc.isSwapping).toBe(false);
    expect(made[0]!.stopped).toBe(false);
    expect(made[0]!.muted).toBe(false);
    // The server asks again: this time it goes through.
    await pc.handOver('p2');
    expect(pc.floor).toBe('p2');
    expect(made[0]!.stopped).toBe(true);
  });

  it('a_new_voice_that_fails_to_start_is_stopped_and_the_old_floor_hears_again', async () => {
    const { pc, made } = setup('swap', undefined, { slow: ['p2'] });
    await pc.start();
    const swapping = pc.handOver('p2');
    await vi.waitFor(() => expect(made).toHaveLength(2));
    expect(made[0]!.muted).toBe(true);
    (made[1] as SlowTransport).fail(new Error('no room'));
    await expect(swapping).rejects.toThrow('no room');
    expect(made[1]!.stopped).toBe(true);
    expect(made[1]!.sentEvents).toEqual([]);
    expect(made[0]!.muted).toBe(false);
    expect(pc.floor).toBe('p1');
  });

  it('a_new_voice_that_drops_before_it_takes_the_floor_fails_the_swap', async () => {
    const { waitQuiet, quiet } = sentence();
    const { pc, made } = setup('swap', undefined, { waitQuiet });
    await pc.start();
    const swapping = pc.handOver('p2');
    await vi.waitFor(() => expect(made[1]?.started).toBe(true));
    made[1]!.events.emit('ended', { reason: 'server' });
    quiet();
    await expect(swapping).rejects.toThrow(/ended before it took the floor/);
    expect(pc.floor).toBe('p1');
    expect(made[0]!.muted).toBe(false);
    expect(made[1]!.sentEvents).toEqual([]);
  });

  it('calling_off_a_swap_keeps_the_old_floor_and_drops_queued_ones', async () => {
    const { waitQuiet, quiet } = sentence();
    const { pc, made, joinPanelist } = setup('swap', [panelist('p1', 0), panelist('p2', 1), panelist('p3', 2)], { waitQuiet });
    await pc.start();
    const first = pc.handOver('p2');
    const second = pc.handOver('p3');
    await vi.waitFor(() => expect(made[1]?.started).toBe(true));
    pc.cancelHandOvers();
    expect(made[1]!.stopped).toBe(true);
    expect(made[0]!.muted).toBe(false);
    quiet();
    await first;
    await second;
    expect(pc.floor).toBe('p1');
    expect(made[1]!.sentEvents).toEqual([]);
    expect(joinPanelist).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(2);
  });

  it('a_second_hand_over_waits_for_the_first_and_then_swaps_again', async () => {
    const { pc, made } = setup('swap', [panelist('p1', 0), panelist('p2', 1), panelist('p3', 2)]);
    await pc.start();
    await Promise.all([pc.handOver('p2'), pc.handOver('p3')]);
    expect(made.map((t) => t.panelistId)).toEqual(['p1', 'p2', 'p3']);
    expect(made[1]!.sentEvents).toEqual(['[event: handover]']);
    expect(made[2]!.sentEvents).toEqual(['[event: handover]']);
    expect(made[0]!.stopped && made[1]!.stopped).toBe(true);
    expect(pc.floor).toBe('p3');
    expect(made[2]!.muted).toBe(false);
  });

  it('the_outgoing_voice_stops_a_short_tail_after_the_switch_and_stop_all_still_stops_it', async () => {
    vi.useFakeTimers();
    try {
      const { pc, made } = setup('swap', undefined, { tailMs: OLD_VOICE_TAIL_MS });
      await pc.start();
      await pc.handOver('p2');
      expect(made[1]!.sentEvents).toEqual(['[event: handover]']);
      expect(made[0]!.stopped).toBe(false); // the end of its last word still plays
      await vi.advanceTimersByTimeAsync(OLD_VOICE_TAIL_MS - 1);
      expect(made[0]!.stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(made[0]!.stopped).toBe(true);

      const second = setup('swap', undefined, { tailMs: OLD_VOICE_TAIL_MS });
      await second.pc.start();
      await second.pc.handOver('p2');
      await second.pc.stopAll(); // the round ends inside the tail
      expect(second.made[0]!.stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a_hand_over_after_a_swap_waits_for_the_new_voice_to_say_its_line', async () => {
    const asked: [string, boolean][] = [];
    const waitQuiet = vi.fn(async (t: VoiceTransport, expectSpeech?: boolean) => void asked.push([t.panelistId, !!expectSpeech]));
    const { pc, made } = setup('swap', [panelist('p1', 0), panelist('p2', 1), panelist('p3', 2)], { waitQuiet });
    await pc.start();
    await pc.handOver('p2');
    await pc.handOver('p3');
    // p2 was asked for its line and had not started it: the wait expects its speech.
    expect(asked).toContainEqual(['p2', true]);
    // Once a voice has started speaking it owes nothing more.
    const { pc: pc2, made: made2 } = setup('swap', [panelist('p1', 0), panelist('p2', 1), panelist('p3', 2)], { waitQuiet });
    asked.length = 0;
    await pc2.start();
    await pc2.handOver('p2');
    made2[1]!.mode('speaking');
    await pc2.handOver('p3');
    expect(asked).toContainEqual(['p2', false]);
    expect(made.length).toBe(3);
  });

  it('mute_all_never_reopens_the_outgoing_floor_mid_swap', async () => {
    const { waitQuiet, quiet } = sentence();
    const { pc, made } = setup('swap', undefined, { waitQuiet });
    await pc.start();
    const swapping = pc.handOver('p2');
    await vi.waitFor(() => expect(made[1]?.started).toBe(true));
    await pc.muteAll(false); // the user unmutes, or a long-answer hold ends
    expect(made[0]!.muted).toBe(true);
    expect(made[1]!.muted).toBe(true);
    quiet();
    await swapping;
    expect(made[1]!.muted).toBe(false);
  });

  it('stop_all_stops_every_transport', async () => {
    const { pc, made } = setup('joined');
    await pc.start();
    await pc.stopAll();
    expect(made.every((t) => t.stopped)).toBe(true);
  });
});

describe('PanelController lifecycle', () => {
  it('stop_all_during_start_stops_the_late_transport', async () => {
    const { pc, made } = setup('swap', undefined, { slow: ['p1'] });
    const starting = pc.start();
    await vi.waitFor(() => expect(made).toHaveLength(1));
    await pc.stopAll();
    (made[0] as SlowTransport).release();
    await starting;
    expect(made[0]!.stopped).toBe(true);
    expect(pc.all()).toHaveLength(0);
  });

  it('stop_all_during_swap_stops_the_new_transport', async () => {
    const { pc, made } = setup('swap', undefined, { slow: ['p2'] });
    await pc.start();
    const swapping = pc.handOver('p2');
    await vi.waitFor(() => expect(made).toHaveLength(2));
    await pc.stopAll();
    (made[1] as SlowTransport).release();
    await swapping;
    expect(made[1]!.stopped).toBe(true);
    expect(made[0]!.stopped).toBe(true);
    expect(pc.all()).toHaveLength(0);
  });

  it('handover_joins_at_once_and_switches_when_the_old_panelist_is_quiet', async () => {
    const { waitQuiet, quiet } = sentence();
    const { pc, joinPanelist, made } = setup('swap', undefined, { waitQuiet });
    await pc.start();
    const swapping = pc.handOver('p2');
    await vi.waitFor(() => expect(made[1]?.started).toBe(true));
    // Joined and connected while the old panelist still speaks; it only stopped hearing the user.
    expect(waitQuiet).toHaveBeenCalledWith(made[0], false);
    expect(joinPanelist).toHaveBeenCalledTimes(1);
    expect(made[0]!.muted).toBe(true);
    expect(made[0]!.stopped).toBe(false);
    expect(made[1]!.sentEvents).toEqual([]);
    expect(pc.floor).toBe('p1');
    quiet();
    await swapping;
    expect(made[1]!.sentEvents).toEqual(['[event: handover]']);
    expect(pc.floor).toBe('p2');
  });

  it('a_paused_round_holds_the_joined_voice_silent_until_ready', async () => {
    let go!: () => void;
    const ready = vi.fn(() => new Promise<void>((r) => (go = r)));
    const { pc, made } = setup('swap', undefined, { ready });
    await pc.start();
    const swapping = pc.handOver('p2');
    await vi.waitFor(() => expect(ready).toHaveBeenCalled());
    expect(made[1]!.started).toBe(true);
    expect(made[1]!.muted).toBe(true);
    expect(made[1]!.sentEvents).toEqual([]);
    expect(made[0]!.stopped).toBe(false);
    go();
    await swapping;
    expect(made[1]!.sentEvents).toEqual(['[event: handover]']);
    expect(made[0]!.stopped).toBe(true);
  });

  it('joined_start_mutes_non_floor_before_connecting', async () => {
    const { pc, log } = setup('joined');
    await pc.start();
    expect(log.indexOf('mute:p2')).toBeLessThan(log.indexOf('start:p2'));
    expect(log.indexOf('mute:p1')).toBe(-1);
  });
});
