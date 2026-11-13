import { describe, expect, it } from 'vitest';
import { LatencyTracker } from './latency';

describe('LatencyTracker', () => {
  it('splits_final_to_thinking_to_first_text', () => {
    const l = new LatencyTracker();
    l.userFinal(1000);
    l.thinking(1300);
    l.thinking(1400);
    expect(l.take()).toBeNull();
    expect(l.agentText(2200)).toEqual({ turn: 1, user_final_at_ms: 1000, to_thinking_ms: 300, to_first_text_ms: 1200 });
    expect(l.agentText(2300)).toBeNull(); // later deltas of the same reply
    expect(l.take()).toMatchObject({ turn: 1 });
    expect(l.take()).toBeNull();
  });

  it('uses_the_last_final_and_allows_no_thinking', () => {
    const l = new LatencyTracker();
    l.userFinal(1000);
    l.userFinal(1800);
    expect(l.agentText(2500)).toEqual({ turn: 1, user_final_at_ms: 1800, to_thinking_ms: null, to_first_text_ms: 700 });
    l.userFinal(5000);
    expect(l.agentText(6000)?.turn).toBe(2);
    expect(l.history).toHaveLength(2);
  });

  it('ignores_agent_text_without_a_user_turn', () => {
    const l = new LatencyTracker();
    expect(l.agentText(100)).toBeNull();
  });

  it('ignores_trailing_text_of_the_interrupted_segment', () => {
    const l = new LatencyTracker();
    l.userFinal(1000, 'a1');
    expect(l.agentText(1010, 'a1')).toBeNull();
    expect(l.agentText(2400, 'a2')).toMatchObject({ to_first_text_ms: 1400 });
  });

  it('keeps_a_thinking_that_came_just_before_the_final', () => {
    const l = new LatencyTracker();
    l.thinking(900);
    l.userFinal(1000);
    expect(l.agentText(1800)).toMatchObject({ to_thinking_ms: -100, to_first_text_ms: 800 });
    l.thinking(5000); // marker turn, no user final: forgotten at its reply
    l.agentText(5500);
    l.userFinal(6000);
    expect(l.agentText(7000)).toMatchObject({ to_thinking_ms: null });
  });
});

