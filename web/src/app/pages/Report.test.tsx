import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import { fakeReport } from '../fake/server';
import { $, $$, cleanup, click, renderApp, settle, stubNavigator, useFakeServer } from '../test-utils';

const sections = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[data-test^="report-section-"]')].map((s) => s.dataset.test!.replace('report-section-', ''));

describe('Report', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('report_orders_sections', async () => {
    useFakeServer();
    const root = await renderApp('/report/demo');
    expect(sections(root)).toEqual(['verdict', 'competencies', 'strengths', 'weaknesses', 'weakest', 'drills', 'delivery', 'transcript', 'share']);
    expect($(root, 'verdict')?.dataset.label).toBe('leaning_hire');
    expect($$(root, 'bar')).toHaveLength(4);
    expect($$(root, 'delta').map((d) => d.dataset.dir)).toEqual(['up', 'same', 'down']);
  });

  it('report_explains_the_scale_in_one_tap', async () => {
    useFakeServer();
    const root = await renderApp('/report/demo');
    expect($(root, 'verdict-explain')).toBeNull();
    await click($(root, 'verdict-explain-toggle'));
    expect($(root, 'verdict-explain')).not.toBeNull();
    expect($(root, 'verdict-explain-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('report_hides_play_without_a_recording', async () => {
    useFakeServer();
    const root = await renderApp('/report/demo');
    expect($$(root, 'play')).toHaveLength(0);
    expect($$(root, 'stamp').length).toBeGreaterThan(0);
  });

  it('report_plays_the_moment_from_the_recording', async () => {
    const report = { ...fakeReport('demo'), recording_url: '/rec/demo.mp3' };
    useFakeServer({ routes: { 'GET /api/sessions/demo/report': () => report } });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const root = await renderApp('/report/demo');
    const btn = $$(root, 'play')[0]!;
    await click(btn);
    const audio = root.querySelector('audio')!;
    expect(play).toHaveBeenCalled();
    expect(audio.currentTime).toBe(Number(btn.closest<HTMLElement>('[data-test="quote"]')!.dataset.t));
  });

  it('report_links_retry_and_drills', async () => {
    useFakeServer();
    const root = await renderApp('/report/demo');
    expect($(root, 'retry-answer')?.getAttribute('href')).toBe('/round/sde.system_design.short?retry=demo');
    const drills = $$(root, 'drill').map((d) => d.getAttribute('href'));
    expect(drills).toEqual(['/round/sde.system_design.short?retry=demo', '/round/sde.system_design.short']);
  });

  it('report_shows_the_retries_line', async () => {
    useFakeServer();
    const root = await renderApp('/report/demo');
    const rows = $(root, 'retries')!.querySelectorAll('li');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector('.retry-scores')?.textContent).toMatch(/^2\s*→\s*to\s*3$/);
    expect(rows[0]!.textContent).toContain('Named the write path as the bottleneck and the cost of sharding.');
  });

  it('report_of_a_retry_moves_to_its_parent', async () => {
    // A retry answers with its parent's report, which carries the new before and after.
    const parent = fakeReport('demo');
    parent.weakest_moment!.retries = [
      ...(parent.weakest_moment!.retries ?? []),
      { session_id: 'child1', at: '2026-11-13T10:00:00Z', before_score: 2, after_score: 4, note: 'You named the bottleneck and its cost.' },
    ];
    const server = useFakeServer({ routes: { 'GET /api/sessions/child1/report': () => parent, 'GET /api/sessions/demo/report': () => parent } });
    const root = await renderApp('/report/child1');
    expect(location.pathname).toBe('/report/demo');
    expect($(root, 'retries')!.querySelectorAll('li')).toHaveLength(2);
    expect($(root, 'retries')!.textContent).toContain('You named the bottleneck and its cost.');
    expect($(root, 'retry-answer')?.getAttribute('href')).toBe('/round/sde.system_design.short?retry=demo');
    // The page kept the report it had: one fetch, no second load.
    expect(server.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/report'))).toHaveLength(1);
  });

  it('report_without_a_retry_prompt_offers_no_retry', async () => {
    const report = fakeReport('demo');
    report.weakest_moment = { ...report.weakest_moment!, retry: undefined };
    useFakeServer({ routes: { 'GET /api/sessions/demo/report': () => report } });
    const root = await renderApp('/report/demo');
    expect($(root, 'weakest')).not.toBeNull();
    expect($(root, 'retry-answer')).toBeNull();
    expect($$(root, 'drill').map((d) => d.getAttribute('href'))).toEqual([null, '/round/sde.system_design.short']);
  });

  it('report_share_warns_that_a_meeting_names_people', async () => {
    useFakeServer();
    const root = await renderApp('/report/meeting');
    expect($(root, 'share-names-note')).not.toBeNull();
    cleanup();
    useFakeServer();
    const demo = await renderApp('/report/demo');
    expect($(demo, 'share-names-note')).toBeNull();
  });

  it('report_share_shows_what_the_live_link_shares', async () => {
    const report = { ...fakeReport('demo'), share: { public_slug: 'k7m2q1', include_quotes: true } };
    useFakeServer({ routes: { 'GET /api/sessions/demo/report': () => report } });
    const root = await renderApp('/report/demo');
    expect($(root, 'share-toggle')?.getAttribute('aria-checked')).toBe('true');
    expect(($(root, 'share-transcript') as HTMLInputElement).checked).toBe(true);
  });

  it('report_keeps_the_transcript_collapsed', async () => {
    useFakeServer();
    const root = await renderApp('/report/demo');
    expect(($(root, 'transcript') as HTMLDetailsElement).open).toBe(false);
  });

  it('report_shares_without_transcript_by_default', async () => {
    const server = useFakeServer();
    const root = await renderApp('/report/demo');
    expect(($(root, 'share-transcript') as HTMLInputElement).checked).toBe(false);
    await click($(root, 'share-toggle'));
    const call = server.calls.find((c) => c.method === 'POST' && c.path === '/api/shares');
    expect(call?.body).toEqual({ session_id: 'demo', include_transcript: false });
    expect($(root, 'share-toggle')?.getAttribute('aria-checked')).toBe('true');
    expect($(root, 'share-link')).not.toBeNull();
  });

  it('report_share_transcript_change_leaves_one_live_link', async () => {
    const server = useFakeServer();
    const root = await renderApp('/report/demo');
    await click($(root, 'share-toggle'));
    expect([...server.state.shares.keys()]).toHaveLength(1);
    await click($(root, 'share-transcript'));
    const live = [...server.state.shares.entries()];
    expect(live).toHaveLength(1);
    expect(live[0]![1]).toEqual({ session_id: 'demo', include_transcript: true });
    expect(($(root, 'share-link')?.querySelector('input') as HTMLInputElement).value).toContain(`/s/${live[0]![0]}`);
    await click($(root, 'share-transcript'));
    expect([...server.state.shares.values()]).toEqual([{ session_id: 'demo', include_transcript: false }]);
    await click($(root, 'share-toggle'));
    expect(server.state.shares.size).toBe(0);
  });

  it('report_copy_falls_back_to_selecting_the_link', async () => {
    useFakeServer();
    const restore = stubNavigator('clipboard', { writeText: () => Promise.reject(new Error('blocked')) });
    try {
      const root = await renderApp('/report/demo');
      await click($(root, 'share-toggle'));
      await click($(root, 'share-copy'));
      expect($(root, 'share-copy-manual')).not.toBeNull();
      expect(document.activeElement).toBe($(root, 'share-link')!.querySelector('input'));
    } finally {
      restore();
    }
  });

  it('report_share_change_rolls_back_when_the_old_link_cannot_go', async () => {
    const server = useFakeServer({
      routes: { 'DELETE /api/shares/k7m2q1': () => new Response('{"code":"boom","message":"x"}', { status: 500 }) },
    });
    const root = await renderApp('/report/demo');
    await click($(root, 'share-toggle'));
    await click($(root, 'share-transcript'));
    expect(($(root, 'share-transcript') as HTMLInputElement).checked).toBe(false);
    expect([...server.state.shares.values()]).toEqual([{ session_id: 'demo', include_transcript: false }]);
    expect(root.querySelector('.share [role="alert"]')).not.toBeNull();
  });

  it('report_meeting_without_details_shows_no_decision', async () => {
    const report = { ...fakeReport('meeting'), round_details: undefined };
    useFakeServer({ routes: { 'GET /api/sessions/meeting/report': () => report } });
    const root = await renderApp('/report/meeting');
    expect($(root, 'no-signal')?.dataset.kind).toBe('meeting');
    expect($(root, 'verdict')).toBeNull();
    expect($(root, 'report-broken')).toBeNull();
  });

  it('report_with_a_verdict_but_no_round_details_still_shows_it', async () => {
    const report = { ...fakeReport('demo'), round_details: undefined };
    useFakeServer({ routes: { 'GET /api/sessions/demo/report': () => report } });
    const root = await renderApp('/report/demo');
    expect($(root, 'verdict')).not.toBeNull();
  });

  it('report_that_cannot_render_shows_a_calm_retry', async () => {
    let broken = true;
    useFakeServer({
      routes: { 'GET /api/sessions/demo/report': () => (broken ? { ...fakeReport('demo'), competencies: null } : fakeReport('demo')) },
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = await renderApp('/report/demo');
    expect($(root, 'report-broken')).not.toBeNull();
    broken = false;
    await click($(root, 'report-broken-retry'));
    expect($(root, 'report-broken')).toBeNull();
    expect($(root, 'verdict')).not.toBeNull();
    spy.mockRestore();
  });

  it('a_report_whose_summary_is_the_chip_says_not_enough_signal_once', async () => {
    // What the server writes for a round with too little to score: its summary is the chip's own words.
    const report = { ...fakeReport('nosignal') };
    report.headline = { ...report.headline, summary: 'Not enough signal yet.' };
    useFakeServer({ routes: { 'GET /api/sessions/thin/report': () => report } });
    const root = await renderApp('/report/thin');
    const box = $(root, 'no-signal')!;
    expect(box).not.toBeNull();
    expect((box.textContent ?? '').match(/not enough signal yet/gi)).toHaveLength(1);
    expect(box.querySelector('.verdict-summary')).toBeNull();
    expect($(root, 'verdict')).toBeNull(); // no verdict chip is guessed
    expect($(root, 'no-signal-again')!.getAttribute('href')).toBe(`/round/${report.session.round_id}`);
    // A summary that says more is kept, next to the chip.
    cleanup();
    const more = { ...fakeReport('nosignal') };
    useFakeServer({ routes: { 'GET /api/sessions/thin2/report': () => more } });
    const root2 = await renderApp('/report/thin2');
    expect($(root2, 'no-signal')!.querySelector('.verdict-summary')!.textContent).toBe(more.headline.summary);
  });

  it('report_says_not_enough_signal_instead_of_a_verdict', async () => {
    useFakeServer();
    const root = await renderApp('/report/nosignal');
    expect($(root, 'no-signal')).not.toBeNull();
    expect($(root, 'verdict')).toBeNull();
    // It says what was missing (enough answers and speech), not how long the round was.
    const text = $(root, 'no-signal')!.textContent ?? '';
    expect(text).toContain('two full answers');
    expect(text).toMatch(/about a minute/);
    expect(text).not.toContain('lasted about');
  });

  it('report_shows_meeting_outcome_and_no_hire_verdict', async () => {
    useFakeServer();
    const root = await renderApp('/report/meeting');
    expect($(root, 'meeting-outcome')?.dataset.outcome).toBe('approved_with_conditions');
    expect($(root, 'verdict')).toBeNull();
    expect(sections(root)).toContain('room');
  });

  it('report_shows_progress_while_scoring_then_the_report', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    useFakeServer();
    const root = await renderApp('/report/scoring');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect($(root, 'report-scoring')).not.toBeNull();
    for (let i = 0; i < 4 && !$(root, 'verdict'); i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2600);
      });
    }
    expect($(root, 'report-scoring')).toBeNull();
    expect($(root, 'verdict')).not.toBeNull();
  });

  it('report_says_history_when_scoring_is_slow', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    useFakeServer({
      routes: {
        'GET /api/sessions/slow/report': () => new Response('{"code":"not_ready","message":"x"}', { status: 404 }),
        'GET /api/sessions/slow': () => ({ status: 'scoring', report_ready: false }),
      },
    });
    const root = await renderApp('/report/slow');
    expect($(root, 'report-scoring')).not.toBeNull();
    expect($(root, 'report-slow')).toBeNull();
    expect(root.querySelector('[role="progressbar"]')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect($(root, 'report-slow')).not.toBeNull();
  });

  it('report_shows_failed_state', async () => {
    useFakeServer();
    const root = await renderApp('/report/failed');
    await settle();
    expect($(root, 'report-failed')).not.toBeNull();
  });

  it('a_failed_report_offers_try_again_which_scores_it_again', async () => {
    let status = 'failed';
    const server = useFakeServer({
      routes: {
        'GET /api/sessions/f1/report': () => new Response(JSON.stringify({ code: 'not_ready', message: 'Report not ready' }), { status: 404 }),
        'GET /api/sessions/f1': () => ({ status, report_ready: false }),
        'POST /api/sessions/f1/report': () => {
          status = 'scoring';
          return new Response(JSON.stringify({ status: 'scoring' }), { status: 202, headers: { 'content-type': 'application/json' } });
        },
      },
    });
    const root = await renderApp('/report/f1');
    await settle();
    expect($(root, 'report-failed')).not.toBeNull();
    await click($(root, 'report-retry'));
    await settle();
    expect(server.calls.filter((c) => c.method === 'POST' && c.path === '/api/sessions/f1/report')).toHaveLength(1);
    expect($(root, 'report-failed')).toBeNull();
    expect($(root, 'report-scoring')).not.toBeNull();
  });

  it('try_again_at_the_daily_limit_says_so_and_stays', async () => {
    useFakeServer({
      routes: {
        'GET /api/sessions/f2/report': () => new Response(JSON.stringify({ code: 'not_ready', message: 'Report not ready' }), { status: 404 }),
        'GET /api/sessions/f2': () => ({ status: 'failed', report_ready: false }),
        'POST /api/sessions/f2/report': () =>
          new Response(JSON.stringify({ code: 'rescore_limit', message: 'This report was retried twice today. Try again tomorrow.' }), { status: 429 }),
      },
    });
    const root = await renderApp('/report/f2');
    await settle();
    await click($(root, 'report-retry'));
    await settle();
    expect($(root, 'report-retry-error')?.textContent).toBe('This report was retried twice today. Try again tomorrow.');
    expect($(root, 'report-failed')).not.toBeNull();
    // Another tap would only be refused again: the button stays off with the message.
    expect(($(root, 'report-retry') as HTMLButtonElement).disabled).toBe(true);
  });

  it('try_again_on_a_report_scored_meanwhile_shows_the_report', async () => {
    let scored = false;
    useFakeServer({
      routes: {
        'GET /api/sessions/f3/report': () =>
          scored ? fakeReport('f3') : new Response(JSON.stringify({ code: 'not_ready', message: 'Report not ready' }), { status: 404 }),
        'GET /api/sessions/f3': () => ({ status: scored ? 'scored' : 'failed', report_ready: scored }),
        'POST /api/sessions/f3/report': () => {
          // Another tab's try finished first.
          scored = true;
          return new Response(JSON.stringify({ code: 'conflict', message: 'This report is already scored.' }), { status: 409 });
        },
      },
    });
    const root = await renderApp('/report/f3');
    await settle();
    await click($(root, 'report-retry'));
    await settle();
    expect($(root, 'report-retry-error')).toBeNull();
    expect($(root, 'report-failed')).toBeNull();
    expect($(root, 'report-section-verdict')).not.toBeNull();
  });

  it('report_lists_the_board_in_words_part_by_part', async () => {
    useFakeServer();
    const root = await renderApp('/report/demo');
    const list = $(root, 'board-text')!;
    expect(list.tagName).toBe('UL');
    const items = [...list.querySelectorAll('li')];
    expect(items.map((li) => li.querySelector('.board-part')?.textContent)).toEqual(['Components', 'Links']);
    expect(items[1]!.textContent).toContain('Shortener → Redis (read-through)');
    expect(list.textContent).not.toMatch(/\[Board update|do not read aloud/);
  });
});
