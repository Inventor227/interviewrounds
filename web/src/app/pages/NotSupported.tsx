// For browsers that can run neither a round nor a preview (no microphone access, usually an old
// browser or a page opened over plain http).

import { Qr } from '../components/Qr';
import { Page } from '../components/Ui';

export function NotSupported() {
  const url = typeof location === 'undefined' ? 'https://rounds.dijmo.com' : location.origin;
  return (
    <Page test="not-supported" title="This browser cannot run a round" lede="Rounds need a microphone, and this browser does not give pages access to one.">
      <div class="ns">
        <div>
          <h2 class="section-title">What works</h2>
          <ul class="checks">
            <li>The Quest Browser on Meta Quest 3 or 3S, for the full room</li>
            <li>Chrome, Edge or Safari on a laptop or phone, for a preview on the screen</li>
          </ul>
          <p>Make sure the address starts with https. Your reports and history open in any browser.</p>
          <div class="row">
            <a class="btn" href="/history">
              Your reports
            </a>
          </div>
        </div>
        <div class="quest">
          <Qr text={url} label="QR code with the link to this site" />
          <div class="quest-text">
            <p>
              <strong>Open on Quest</strong>
            </p>
            <p class="url">{url.replace(/^https?:\/\//, '')}</p>
          </div>
        </div>
      </div>
    </Page>
  );
}
