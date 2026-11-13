// Resume a dropped round: the same two taps as Start (mic and resume, then Enter the room).

import { useLocation } from 'preact-iso';
import type { Me } from '../../shared/types';
import { loadMe, useAsync } from '../components/data';
import { clock } from '../components/format';
import { ReadyPanel, useHeadset, useMic } from '../components/Ready';
import { ErrorState, Loading, Page } from '../components/Ui';
import { voiceChoice } from '../voiceChoice';
import { useNow } from './Home';

function ResumeBody(props: { id: string; me: Me }) {
  const { query } = useLocation();
  const mic = useMic();
  const xr = useHeadset(query.preview === '1');
  const now = useNow();
  const r = props.me.resumable;
  const left = r && r.session_id === props.id ? Math.max(0, (Date.parse(r.expires_at) - now) / 1000) : 0;

  if (!r || left <= 0) {
    return (
      <div class="state" data-test="resume-gone">
        <h2>This round can no longer be resumed</h2>
        <p>It is scored as far as it went, and the report will be in your history.</p>
        <div class="row">
          <a class="btn btn-primary" href={`/report/${encodeURIComponent(props.id)}`}>
            See the report
          </a>
          <a class="btn" href="/">
            Go home
          </a>
        </div>
      </div>
    );
  }
  return (
    <>
      <p class="note" data-test="resume-note">
        The interviewer picks up where you left off. You have <span class="num">{clock(left)}</span> to come back.
      </p>
      <ReadyPanel
        mic={mic}
        xr={xr}
        questUrl={typeof location === 'undefined' ? '' : `${location.origin}/resume/${encodeURIComponent(props.id)}`}
        input={{ kind: 'resume', sessionId: props.id, voice: voiceChoice() }}
        title={r.round_title}
        me={props.me}
        enterLabel={xr === 'none' ? 'Resume on this screen' : 'Enter the room'}
      />
    </>
  );
}

export function Resume(props: { id?: string }) {
  const id = props.id ?? '';
  const me = useAsync(() => loadMe(), []);
  const title = me.data?.resumable?.session_id === id ? `Resume ${me.data.resumable.round_title}` : 'Resume your round';
  return (
    <Page test="resume" title={title} back={{ href: '/', label: 'Home' }} attrs={{ 'data-session': id }}>
      {me.status === 'loading' && <Loading rows={3} />}
      {me.status === 'error' && <ErrorState error={me.error} onRetry={me.reload} />}
      {me.status === 'ready' && <ResumeBody id={id} me={me.data} />}
    </Page>
  );
}
