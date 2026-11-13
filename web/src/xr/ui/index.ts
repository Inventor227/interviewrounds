// The round UI the controller drives: setRoundState, setStatus, showSummary, setCaption, onAction.
// Panels are plain groups; the world places them in the desk frame (headset) or on the camera (preview).

import type { Object3D } from 'three';
import type { Report } from '../../shared/types';
import type { HeadPose } from '../placement';
import type { DeskFrame } from '../seats';
import type { Sounds } from '../sound';
import { BriefCard } from './briefCard';
import { Captions } from './captions';
import { layoutDesk, layoutHeadStatus, layoutHud, type PanelName, type PanelPose } from './layout';
import { RoundBar } from './roundBar';
import { StatusCard } from './statusCard';
import { SummaryCard, summaryFromReport } from './summaryCard';
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
  readonly status = new StatusCard();
  readonly summary: SummaryCard;
  readonly captions = new Captions();
  private readonly listeners = new Set<(a: RoundAction) => void>();
  private chrome = false;
  private lastStage: StatusStage | null = null;
  private state: RoundUIState | null = null;

  constructor(private readonly sounds?: Sounds) {
    const emit = (a: RoundAction) => this.emit(a);
    this.roundBar = new RoundBar(emit);
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

  get chromeVisible(): boolean {
    return this.chrome;
  }

  layoutDesk(desk: DeskFrame, except: PanelName[] = []): void {
    const poses = layoutDesk(desk);
    const g = this.groups;
    for (const k of Object.keys(poses) as PanelName[]) if (!except.includes(k)) apply(g[k], poses[k]);
  }

  layoutHeadStatus(head: HeadPose): void {
    apply(this.status.group, layoutHeadStatus(head));
  }

  layoutHud(aspect: number, vfovDeg: number): void {
    const poses = layoutHud(aspect, vfovDeg);
    const g = this.groups;
    for (const [k, p] of Object.entries(poses) as [PanelName, PanelPose][]) apply(g[k], p);
  }

  /** dt seconds. */
  update(dt: number, nowMs: number): void {
    this.roundBar.tick(dt, nowMs);
  }

  private emit(a: RoundAction): void {
    this.sounds?.click();
    if (a === 'captions') {
      const on = !this.captions.isEnabled;
      this.captions.setEnabled(on);
      this.roundBar.setCaptions(on);
    }
    for (const cb of this.listeners) cb(a);
  }
}
