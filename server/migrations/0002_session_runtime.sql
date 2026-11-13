-- Live session runtime: client tokens with their socket seq record, the server frame buffer, a snapshot of the
-- live state (to reload a session after a restart), Fish spend reservations and socket telemetry.

-- One row per issued client_token (create, then one more per resume). Socket seq and dedupe are per token.
create table session_tokens (
    id              bigserial primary key,
    session_id      uuid not null references sessions (id) on delete cascade,
    -- sha-256 of the token; the raw value is never stored
    token_hash      bytea not null unique,
    -- highest client frame seq processed for this token
    last_client_seq bigint not null default 0,
    created_at      timestamptz not null default now(),
    revoked_at      timestamptz
);
create index session_tokens_live_idx on session_tokens (session_id) where revoked_at is null;

-- Numbered server frames (seq > 0), replayed after a reconnect.
create table session_frames (
    session_id uuid not null references sessions (id) on delete cascade,
    seq        bigint not null,
    frame      jsonb not null,
    created_at timestamptz not null default now(),
    primary key (session_id, seq)
);

alter table sessions
    add column question_id         text,
    -- model history, turn log, phase, floor and brief of a live session
    add column live_state          jsonb,
    add column live_state_at       timestamptz,
    -- spend held back for this session's Fish minutes until the real minutes are recorded
    add column fish_reserved_usd   numeric(12, 6) not null default 0,
    add column fish_usage_recorded boolean not null default false;

-- `voice.state` (with its latency split), `ui.event` and `board.ghost_reject` frames as received.
create table session_events (
    id         bigserial primary key,
    session_id uuid not null references sessions (id) on delete cascade,
    kind       text not null,
    at_ms      bigint,
    data       jsonb not null,
    created_at timestamptz not null default now()
);
create index session_events_session_idx on session_events (session_id, id);

create index sessions_identity_day_idx on sessions (identity_id, length, created_at);
