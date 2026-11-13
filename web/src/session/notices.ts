// The designed cards for every interruption of a round: one calm line, a short detail and at most
// two buttons. The round controller picks the card (currentNotice in controller.ts); the headset
// status card and the session page both render from this table, so the words match everywhere.

import type { UiAction } from './ports';

export type NoticeKind =
  /** The user pressed Pause. */
  | 'paused'
  /** Paused by the headset coming off or the system menu, and the user is back. */
  | 'welcome_back'
  /** New voices are being made after a long pause or a lost voice. */
  | 'reconnecting'
  /** The interviewer's model is failing; the server holds the round clock. */
  | 'degraded'
  /** The room socket dropped and is reconnecting by itself. */
  | 'socket'
  /** The voice could not be brought back: the user decides. */
  | 'lost'
  /** Scoring has taken a minute. */
  | 'scoring_slow'
  /** The pause budget ran out. */
  | 'ended_paused';

export interface Notice {
  title: string;
  detail: string;
  /** Buttons, the primary one first. */
  actions: UiAction[];
}

export const NOTICES: Record<NoticeKind, Notice> = {
  paused: { title: 'Paused', detail: "Your interviewer will wait. Resume when you're ready.", actions: ['resume', 'end'] },
  welcome_back: { title: 'Welcome back', detail: "Resume when you're ready.", actions: ['resume', 'end'] },
  reconnecting: { title: 'Reconnecting your interviewer…', detail: '', actions: [] },
  degraded: { title: 'Your interviewer is reconnecting…', detail: '', actions: [] },
  socket: { title: 'Reconnecting…', detail: 'Your progress is saved.', actions: [] },
  lost: { title: 'We lost the connection', detail: 'Your progress is saved. Resume to carry on.', actions: ['resume', 'end'] },
  scoring_slow: { title: 'Your report will be in History', detail: 'It is taking longer than usual. You can wait here or pick it up later.', actions: ['history', 'stay'] },
  ended_paused: { title: 'The round ended while paused', detail: 'Your report is being written.', actions: ['report'] },
};

/** Button labels on the cards. */
export const ACTION_LABELS: Partial<Record<UiAction, string>> = {
  resume: 'Resume',
  end: 'End',
  history: 'See history',
  stay: 'Stay',
  report: 'See report',
  hear: 'Tap to hear',
};
