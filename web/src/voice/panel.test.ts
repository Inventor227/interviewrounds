import { describe, expect, it, vi } from 'vitest';
import type { Panelist } from '../shared/types';
import { PanelController } from './panel';
import { panelist, ScriptedTransport, sessionRes } from './testkit';
import type { TransportOptions, VoiceTransport } from './transport';

/** A transport whose start() waits until the test releases it. */
class SlowTransport extends ScriptedTransport {
  release!: () => void;
  override async start(): Promise<void> {
    this.started = true;
    await new Promise<void>((r) => (this.release = r));
  }
}

function setup(
  mode: 'swap' | 'joined',
  panel = [panelist('p1', 0), panelist('p2', 1)],
  opts: { slow?: string[]; waitQuiet?: (t: VoiceTransport) => Promise<void> } = {},
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
  const joinPanelist = vi.fn(async (_s: string, pid: string, body?: { opening_line?: string }) => {
    log.push(`join:${pid}:${body?.opening_line ?? ''}`);
    return { voice: { transport: 'fake' as const } };
  });
  const res = sessionRes({ panel_mode: mode, panel });
  const pc = new PanelController(res, make, { api: { joinPanelist }, waitQuiet: opts.waitQuiet });
  return { pc, log, made, joinPanelist };
}

describe('PanelController', () => {
  it('swap_handover_starts_new_before_stopping_old', async () => {
    const { pc, log, made, joinPanelist } = setup('swap');
    await pc.start();
    expect(made.map((t) => t.panelistId)).toEqual(['p1']);
    expect(made[0]!.muted).toBe(false);
    log.length = 0;

    await pc.handOver('p2', 'Hi, I am Priya.');

    expect(joinPanelist).toHaveBeenCalledWith('sess1', 'p2', { opening_line: 'Hi, I am Priya.' });
    const iJoin = log.indexOf('join:p2:Hi, I am Priya.');
    const iStart = log.indexOf('start:p2');
    const iStop = log.indexOf('stop:p1');
    expect(iJoin).toBeGreaterThanOrEqual(0);
    expect(iJoin).toBeLessThan(iStart);
    expect(iStart).toBeLessThan(iStop);
    // Never two mics live: the old floor is muted before the join, the new one starts muted.
    expect(log.indexOf('mute:p1')).toBeLessThan(iJoin);
    expect(log.indexOf('mute:p2')).toBeGreaterThan(-1);
    expect(log.indexOf('mute:p2')).toBeLessThan(iStart);
    expect(log.indexOf('unmute:p2')).toBeGreaterThan(iStart);
    expect(made[1]!.opts.openingLine).toBe('Hi, I am Priya.');
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

    await pc.handOver('p2', 'ignored in joined mode');

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
    await pc.handOver('p1', 'again');
    expect(joinPanelist).not.toHaveBeenCalled();
    expect(made).toHaveLength(1);
  });

  it('failed_swap_keeps_the_old_floor', async () => {
    const { pc, made, joinPanelist } = setup('swap');
    await pc.start();
    joinPanelist.mockRejectedValueOnce(new Error('nope'));
    await expect(pc.handOver('p2', 'x')).rejects.toThrow('nope');
    expect(pc.floor).toBe('p1');
    expect(made[0]!.stopped).toBe(false);
    expect(made[0]!.muted).toBe(false);
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
    const swapping = pc.handOver('p2', 'Hi');
    await vi.waitFor(() => expect(made).toHaveLength(2));
    await pc.stopAll();
    (made[1] as SlowTransport).release();
    await swapping;
    expect(made[1]!.stopped).toBe(true);
    expect(made[0]!.stopped).toBe(true);
    expect(pc.all()).toHaveLength(0);
  });

  it('handover_waits_for_the_old_panelist_to_finish', async () => {
    let quiet!: () => void;
    const waitQuiet = vi.fn(() => new Promise<void>((r) => (quiet = r)));
    const { pc, joinPanelist, made } = setup('swap', undefined, { waitQuiet });
    await pc.start();
    const swapping = pc.handOver('p2', 'Hi');
    await vi.waitFor(() => expect(waitQuiet).toHaveBeenCalledWith(made[0]));
    expect(joinPanelist).not.toHaveBeenCalled();
    expect(made[0]!.muted).toBe(false);
    quiet();
    await swapping;
    expect(joinPanelist).toHaveBeenCalled();
    expect(pc.floor).toBe('p2');
  });

  it('joined_start_mutes_non_floor_before_connecting', async () => {
    const { pc, log } = setup('joined');
    await pc.start();
    expect(log.indexOf('mute:p2')).toBeLessThan(log.indexOf('start:p2'));
    expect(log.indexOf('mute:p1')).toBe(-1);
  });
});
