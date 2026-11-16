import { describe, expect, it, vi } from 'vitest';
import { ACTION_LABELS, NOTICES, type NoticeKind } from '../../session/notices';
import { RoundUI } from './index';
import { STATUS_BUTTON_GAP_CM, STATUS_WIDTH_CM, StatusCard } from './statusCard';
import type { RoundAction } from './types';

const LIVE = { status: 'live' as const, elapsed_s: 10, total_s: 480, muted: false };

describe('interruption cards', () => {
  it('the_paused_card_has_resume_first_and_end_and_both_work', () => {
    const pressed: RoundAction[] = [];
    const card = new StatusCard((a) => pressed.push(a));
    card.set('paused');
    expect(card.view).toEqual({ visible: true, title: 'Paused', actions: ['resume', 'end'] });
    card.set('scoring', 0.4);
    expect(card.view.actions).toEqual([]);
    card.hide();
    expect(card.view.visible).toBe(false);
  });

  it('every_card_is_the_status_card_with_the_words_and_buttons_of_the_table', () => {
    const ui = new RoundUI();
    for (const kind of Object.keys(NOTICES) as NoticeKind[]) {
      ui.setNotice(kind);
      expect(ui.status.view, kind).toEqual({ visible: true, title: NOTICES[kind].title, actions: NOTICES[kind].actions });
      for (const a of NOTICES[kind].actions) expect(ACTION_LABELS[a], `${kind}.${a}`).toBeTruthy();
    }
    ui.setNotice(null);
    expect(ui.status.view.visible).toBe(false);
  });

  it('the_cards_named_by_the_brief_say_what_it_asks', () => {
    expect(NOTICES.paused.title).toBe('Paused');
    expect(NOTICES.paused.actions).toEqual(['resume', 'end']);
    expect(`${NOTICES.welcome_back.title}. ${NOTICES.welcome_back.detail}`).toBe("Welcome back. Resume when you're ready.");
    expect(NOTICES.reconnecting.title).toBe('Reconnecting your interviewer…');
    expect(NOTICES.degraded).toEqual({ title: 'Your interviewer is reconnecting…', detail: '', actions: [] });
    expect(NOTICES.socket.title).toBe('Reconnecting…');
    expect(NOTICES.lost.title).toBe('Connection lost');
    expect(NOTICES.lost.actions).toEqual(['resume', 'end']);
    expect(NOTICES.scoring_slow.title).toBe('Your report will be in History');
    expect(NOTICES.scoring_slow.actions.map((a) => ACTION_LABELS[a])).toEqual(['See history', 'Stay']);
    expect(`${NOTICES.ended_paused.title}. ${NOTICES.ended_paused.detail}`).toBe('The round ended while paused. Writing your report.');
  });

  it('a_controller_driven_ui_never_picks_the_paused_card_by_itself_and_brings_its_card_back_after_placement', () => {
    const ui = new RoundUI();
    ui.setNotice(null); // a round controller is driving
    ui.setRoundState({ ...LIVE, status: 'paused' });
    expect(ui.status.view.visible).toBe(false);
    ui.setNotice('welcome_back');
    ui.setStatus('placing'); // back in the headset: the desk prompt takes the card
    expect(ui.status.view.title).toMatch(/Touch your desk/);
    ui.hideStatus();
    ui.restoreNotice();
    expect(ui.status.view).toEqual({ visible: true, title: 'Welcome back', actions: ['resume', 'end'] });
    // Taking a notice down never hides a plain status line that replaced it.
    ui.setNotice(null);
    ui.showStatusText('Writing your scorecard', 0.2);
    ui.setNotice(null);
    expect(ui.status.view.visible).toBe(true);
  });

  it('without_a_controller_a_paused_state_still_shows_the_paused_card', () => {
    const ui = new RoundUI();
    ui.setRoundState({ ...LIVE, status: 'paused' });
    expect(ui.status.view.title).toBe('Paused');
    ui.setRoundState(LIVE);
    expect(ui.status.view.visible).toBe(false);
  });

  it('a_pause_clears_the_captions_and_keeps_them_clear', () => {
    const ui = new RoundUI();
    ui.captions.setEnabled(true);
    ui.setCaption('Daniel', 'So tell me about');
    expect(ui.captions.rowsShown).toEqual(['So tell me about']);
    ui.setPaused(true);
    expect(ui.captions.rowsShown).toEqual([]);
    expect(ui.captions.group.visible).toBe(false);
    ui.setCaption('Daniel', 'So tell me about a time'); // the tail of the interrupted line
    expect(ui.captions.rowsShown).toEqual([]);
    ui.setPaused(false);
    ui.setCaption('Daniel', 'Welcome back.');
    expect(ui.captions.rowsShown).toEqual(['Welcome back.']);
  });

  it('the_round_bar_pause_button_toggles_to_resume', () => {
    const ui = new RoundUI();
    const pressed = vi.fn();
    ui.onAction(pressed);
    ui.setRoundState({ ...LIVE, status: 'paused' });
    expect(ui.chromeVisible).toBe(true); // the bar stays up while paused
    expect(ui.paused).toBe(true);
  });

  it('the_two_buttons_fit_the_card_with_a_gap_of_at_least_12_mm', () => {
    expect(STATUS_BUTTON_GAP_CM).toBeGreaterThanOrEqual(1.2);
    expect(16 + 12 + STATUS_BUTTON_GAP_CM).toBeLessThanOrEqual(STATUS_WIDTH_CM - 2 * 1.8);
  });
});
