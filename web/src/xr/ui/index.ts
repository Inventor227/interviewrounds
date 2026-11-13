// The round UI the controller drives: setRoundState, setStatus, showSummary, setCaption, onAction.
// Panels are plain groups; the world places them in the desk frame (headset) or on the camera (preview).

import { UIKitDocument } from '@iwsdk/core';
import type { Object3D } from 'three';
import type { HeadsetCard, Report } from '../../shared/types';
import type { HeadPose } from '../placement';
import type { DeskFrame } from '../seats';
import type { Sounds } from '../sound';
import { BriefCard } from './briefCard';
import { Captions } from './captions';
import { Hint } from './hint';
import { layoutBriefBeyondSheet, layoutDesk, layoutHeadStatus, layoutHint, layoutHud, type PanelName, type PanelPose } from './layout';
import { RoundBar } from './roundBar';
import { PLACING_COPY, StatusCard } from './statusCard';
import { quickCardFromHeadset, SummaryCard, summaryFromReport } from './summaryCard';
import type { RoundAction, RoundUIState, StatusStage, SummaryView } from './types';

export type { RoundAction, RoundUIState, StatusStage, SummaryView } from './types';
export { summaryFromReport } from './summaryCard';

function apply(o: Object3D, p: PanelPose): void {
  o.position.set(p.pos.x, p.pos.y, p.pos.z);
  o.rotation.set(p.tilt, p.yaw, 0, 'YXZ');
  o.scale.setScalar(p.scale ?? 1);
}

export class RoundUI {
  readonly roundBar: RoundBar;
  readonly brief = new BriefCard();
  readonly status: StatusCard;
  readonly hint = new Hint();
  readonly summary: SummaryCard;
  readonly captions = new Captions();
  /** The input the placement prompt was last worded for (tooling and tests). */
  placingFor: 'hands' | 'controllers' | null = null;
  private readonly listeners = new Set<(a: RoundAction) => void>();
  private chrome = false;
  private lastStage: StatusStage | null = null;
  private state: RoundUIState | null = null;

  constructor(private readonly sounds?: Sounds) {
    const emit = (a: RoundAction) => this.emit(a);
    this.roundBar = new RoundBar(emit, () => this.sounds?.click());
    this.brief.onPress(() => this.sounds?.click());
    this.status = new StatusCard(emit);
    this.summary = new SummaryCard(emit);
    this.setChromeVisible(false);
  }

  /** All panel groups, to add to the scene or the camera. */
  get groups(): Record<PanelName, Object3D> {
    return {
      roundBar: this.roundBar.group,
      brief: this.brief.group,
      status: this.status.group,
      summary: this.summary.group,
      captions: this.captions.group,
    };
  }

  onAction(cb: (a: RoundAction) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  setRoundState(s: RoundUIState): void {
    this.state = { ...s };
    this.roundBar.setState(s);
    this.brief.set(s.brief);
    if (s.captions !== undefined) this.captions.setEnabled(s.captions);
    const live = s.status === 'live' || s.status === 'paused';
    this.setChromeVisible(live);
    if (live) this.summary.hide();
    if (s.status === 'paused') this.setStatus('paused');
    else if (this.lastStage === 'paused') this.hideStatus();
  }

  /** Scoring progress and other calm status lines; pct 0..1 or omitted. */
  setStatus(stage: StatusStage, pct?: number | null): void {
    this.lastStage = stage;
    if (stage === 'done') {
      this.status.hide();
      return;
    }
    this.status.set(stage, pct ?? null);
    if (stage === 'metrics' || stage === 'scoring') this.setChromeVisible(false);
  }

  /** A plain status line from the controller (its own copy), with optional progress. */
  showStatusText(text: string, pct?: number | null): void {
    this.lastStage = null;
    this.status.showText(text, '', pct ?? null);
  }

  hideStatus(): void {
    this.lastStage = null;
    this.status.hide();
  }

  showSummary(summary: SummaryView | Report): void {
    const view = 'schema_version' in summary ? summaryFromReport(summary) : summary;
    this.status.hide();
    this.setChromeVisible(false);
    this.summary.show(view);
    this.sounds?.chime();
  }

  /** The quick card (one line, top strength, top fix) in the summary card's place, until the report is ready. */
  showQuickCard(card: HeadsetCard, opts: { pending?: boolean } = {}): void {
    const first = !this.summary.group.visible;
    this.status.hide();
    this.setChromeVisible(false);
    this.summary.showQuick(quickCardFromHeadset(card), opts.pending ?? true);
    // One chime when the card appears; an update of the same card stays quiet.
    if (first) this.sounds?.chime();
  }

  hideSummary(): void {
    this.summary.hide();
  }

  setCaption(speaker: string, words: string): void {
    this.captions.setCaption(speaker, words);
  }

  setChromeVisible(on: boolean): void {
    this.chrome = on;
    this.roundBar.group.visible = on;
    this.brief.group.visible = on && this.state?.brief != null && !!this.state.brief.question;
  }

  /** The round is paused (as last set by setRoundState). */
  get paused(): boolean {
    return this.state?.status === 'paused';
  }

  get chromeVisible(): boolean {
    return this.chrome;
  }

  /** Draws these panels over everything (preview HUD): no depth test, last in the transparent pass. */
  setOverlay(names: PanelName[]): void {
    const g = this.groups;
    for (const n of names) {
      const doc = g[n].children.find((c): c is UIKitDocument => c instanceof UIKitDocument);
      if (doc) (doc.rootElement as unknown as { setProperties(p: object): void }).setProperties({ renderOrder: 100, depthTest: false });
    }
  }

  layoutDesk(desk: DeskFrame, except: PanelName[] = []): void {
    const poses = layoutDesk(desk);
    const g = this.groups;
    for (const k of Object.keys(poses) as PanelName[]) if (!except.includes(k)) apply(g[k], poses[k]);
  }

  /** Rounds with a board: stand the brief card beyond the sheet instead of on it. */
  layoutBriefBeyondSheet(desk: DeskFrame): void {
    apply(this.brief.group, layoutBriefBeyondSheet(desk));
  }

  layoutHeadStatus(head: HeadPose): void {
    apply(this.status.group, layoutHeadStatus(head));
  }

  layoutHud(aspect: number, vfovDeg: number): void {
    const poses = layoutHud(aspect, vfovDeg);
    const g = this.groups;
    for (const [k, p] of Object.entries(poses) as [PanelName, PanelPose][]) apply(g[k], p);
  }

  /** The desk placement prompt, worded for the input in use (hands: a finger; controllers: the tip and the trigger). */
  showPlacing(input: 'hands' | 'controllers'): void {
    this.lastStage = 'placing';
    this.placingFor = input;
    this.status.showText(PLACING_COPY[input].title, PLACING_COPY[input].detail);
  }

  /** A one-line hint for a few seconds, placed just below the eye line (layoutHint first). */
  showHint(line: string, nowMs: number, forMs = 6000): void {
    this.hint.show(line, nowMs, forMs);
  }

  layoutHint(head: HeadPose): void {
    apply(this.hint.group, layoutHint(head));
  }

  /** dt seconds. */
  update(dt: number, nowMs: number): void {
    this.roundBar.tick(dt, nowMs);
    this.captions.tick(nowMs);
    this.hint.tick(nowMs);
  }

  /** The system took focus (menu, headset off, session ended): pause a live round so the Resume card shows. */
  systemPause(): void {
    if (this.state?.status === 'live') this.emit('pause', false);
  }

  private emit(a: RoundAction, sound = true): void {
    if (sound) this.sounds?.click();
    if (a === 'captions') {
      const on = !this.captions.isEnabled;
      this.captions.setEnabled(on);
      this.roundBar.setCaptions(on);
    }
    for (const cb of this.listeners) cb(a);
  }
}
