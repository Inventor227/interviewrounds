-- Retries (a two minute re-ask of a report's weakest moment) and one live public link per session.

-- A retry is its own session (parent_session_id = the scored round) with length 'retry'.
alter table sessions drop constraint sessions_length_check;
alter table sessions add constraint sessions_length_check check (length in ('short', 'full', 'retry'));

-- What a retry re-asks: {question, prompt, persona_id, competency_id, competency_name, before_score,
-- answer_excerpt}, fixed when the retry is made (the live prompt is rebuilt from it after a restart).
alter table sessions add column retry jsonb;

-- At most one live (not revoked) public link per session.
create unique index shares_live_session_idx on shares (session_id) where revoked_at is null;
