// Hand tracking lost: when neither hand (nor a controller) has been seen for 5 s inside a placed room, one calm
// line asks for the hands back. Once per loss; it re-arms when a hand is seen again. A short dropout, or one hand
// out of view, shows nothing: select events from the other hand or a controller keep working.

export const HANDS_LOST_MS = 5000;
export const HANDS_LOST_LINE = "Can't see your hands. Raise them into view.";

export class HandsLostWatch {
  private since: number | null = null;
  private told = false;

  /** Feed once per XR frame. Returns true once, when nothing has been seen for HANDS_LOST_MS. */
  update(nowMs: number, seen: boolean): boolean {
    if (seen) {
      this.since = null;
      this.told = false;
      return false;
    }
    this.since ??= nowMs;
    if (this.told || nowMs - this.since < HANDS_LOST_MS) return false;
    this.told = true;
    return true;
  }

  /** A new session, or frames stopped for a while (headset off): start counting again. */
  reset(): void {
    this.since = null;
    this.told = false;
  }
}
