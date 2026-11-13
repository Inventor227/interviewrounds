-- Resume budget per session, and an index for the Fish spend still held back by unsettled sessions.

alter table sessions
    add column resume_count integer not null default 0;

create index sessions_unsettled_fish_idx on sessions (id)
    where voice = 'fish' and not fish_usage_recorded;

create index usage_events_provider_day_idx on usage_events (provider, created_at);

-- The board item the user last touched or created (`board.focus`), for the Scribe to resolve "that".
alter table sessions
    add column board_focus text;
