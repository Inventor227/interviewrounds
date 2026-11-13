// Three ways in: Software Engineer, Product Manager, A real meeting.

import { RoleIcon, Tile } from '../components/Tile';
import { Page } from '../components/Ui';

export function PickRole() {
  return (
    <Page test="pick-role" title="What do you want to practice?" lede="Pick one. Every round has sensible defaults, so there is nothing else to fill in.">
      <div class="tiles tiles-tall">
        <Tile href="/start/sde" test="tile-sde" title="Software Engineer" icon={RoleIcon.sde}>
          Coding, system design, object design, behavioral
        </Tile>
        <Tile href="/start/pm" test="tile-pm" title="Product Manager" icon={RoleIcon.pm}>
          Product sense, metrics and execution, leadership
        </Tile>
        <Tile href="/meeting/new" test="tile-meeting" title="A real meeting" icon={RoleIcon.meeting}>
          Rehearse a pitch, a review or a negotiation with the people in it
        </Tile>
      </div>
    </Page>
  );
}
