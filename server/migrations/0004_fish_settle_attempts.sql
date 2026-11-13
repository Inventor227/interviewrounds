-- Failed tries to end a session's Fish sessions; settlement gives up (and records an estimate) after a few.
alter table sessions
    add column fish_settle_attempts integer not null default 0;
