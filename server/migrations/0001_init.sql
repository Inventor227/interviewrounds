-- Interview Rounds: initial schema.
-- Times the browser reports are milliseconds since the session started (*_ms bigint).

-- A device (guest) or a signed-in Google user. Guests are claimed into users on sign-in.
create table identities (
    id              uuid primary key default gen_random_uuid(),
    kind            text not null check (kind in ('guest', 'user')),
    -- sha-256 of the `ir_id` cookie value; the raw value is never stored
    cookie_hash     bytea unique,
    google_sub      text unique,
    email           text,
    name            text,
    claimed_into    uuid references identities (id) on delete set null,
    onboarding_done boolean not null default false,
    created_at      timestamptz not null default now(),
    last_seen_at    timestamptz not null default now(),
    check (kind = 'guest' or google_sub is not null)
);

-- Settings document (shape owned by `Settings` in docs/protocol.md).
create table settings (
    identity_id uuid primary key references identities (id) on delete cascade,
    data        jsonb not null default '{}'::jsonb,
    updated_at  timestamptz not null default now()
);

-- Attendee setup and the plan Claude prepared for a meeting rehearsal.
create table meeting_plans (
    id          uuid primary key default gen_random_uuid(),
    identity_id uuid not null references identities (id) on delete cascade,
    template_id text,
    setup       jsonb not null,
    plan        jsonb not null,
    created_at  timestamptz not null default now()
);
create index meeting_plans_identity_idx on meeting_plans (identity_id, created_at desc);

create table sessions (
    id                uuid primary key default gen_random_uuid(),
    identity_id       uuid not null references identities (id) on delete cascade,
    parent_session_id uuid references sessions (id) on delete set null,
    mode              text not null check (mode in ('interview', 'meeting')),
    round_id          text,
    meeting_plan_id   uuid references meeting_plans (id) on delete set null,
    length            text not null check (length in ('short', 'full')),
    level             text not null check (level in ('junior', 'mid', 'senior', 'staff')),
    style             text not null check (style in ('warm', 'neutral', 'tough')),
    voice             text not null check (voice in ('fish', 'fake')),
    panel_mode        text not null default 'swap' check (panel_mode in ('swap', 'joined')),
    -- snapshot of the settings in force when the session was created
    settings          jsonb not null default '{}'::jsonb,
    -- [Panelist] as sent to the browser
    panel             jsonb not null default '[]'::jsonb,
    -- [{panelist_id, fish_session_id, started_at, ended_at}]
    fish_sessions     jsonb not null default '[]'::jsonb,
    -- sha-256 of the session client token
    client_token_hash bytea,
    status            text not null default 'created'
                      check (status in ('created', 'live', 'paused', 'scoring', 'scored', 'failed', 'abandoned')),
    ended_reason      text check (ended_reason in
                      ('completed', 'user_ended', 'time_limit', 'disconnected', 'headset_removed')),
    paused_total_ms   bigint not null default 0,
    cost_usd          numeric(12, 6) not null default 0,
    created_at        timestamptz not null default now(),
    started_at        timestamptz,
    last_socket_at    timestamptz,
    ended_at          timestamptz,
    scored_at         timestamptz
);
create index sessions_identity_idx on sessions (identity_id, created_at desc);
create index sessions_status_idx on sessions (status) where status in ('created', 'live', 'paused', 'scoring');
create index sessions_parent_idx on sessions (parent_session_id) where parent_session_id is not null;

-- What was said, in order. Event turns (`[event: ...]`) and notes are kept too.
create table turns (
    id           bigserial primary key,
    session_id   uuid not null references sessions (id) on delete cascade,
    seq          integer not null,
    speaker      text not null check (speaker in ('user', 'agent', 'system')),
    panelist_id  text,
    kind         text not null default 'speech' check (kind in ('speech', 'event', 'note')),
    text         text not null,
    started_ms   bigint,
    ended_ms     bigint,
    interrupted  boolean not null default false,
    created_at   timestamptz not null default now(),
    unique (session_id, seq)
);

-- `transcript.mark` from the browser: local timing of each final transcript segment.
create table marks (
    id          bigserial primary key,
    session_id  uuid not null references sessions (id) on delete cascade,
    segment_id  text not null,
    panelist_id text,
    first_at_ms bigint not null,
    final_at_ms bigint not null,
    text        text not null default '',
    created_at  timestamptz not null default now(),
    unique (session_id, segment_id)
);

-- `head.samples` batches (5 Hz yaw/pitch, speaking flag, gaze target).
create table head_batches (
    id         bigserial primary key,
    session_id uuid not null references sessions (id) on delete cascade,
    first_t_ms bigint not null,
    last_t_ms  bigint not null,
    samples    jsonb not null,
    created_at timestamptz not null default now()
);
create index head_batches_session_idx on head_batches (session_id, first_t_ms);

-- Every board op as received (idempotent by op_id) and the rev it produced once applied.
create table board_ops (
    id         bigserial primary key,
    session_id uuid not null references sessions (id) on delete cascade,
    op_id      text not null,
    rev_base   bigint not null,
    rev        bigint,
    src        text not null,
    op         text not null,
    args       jsonb not null default '{}'::jsonb,
    at_ms      bigint not null,
    created_at timestamptz not null default now(),
    unique (session_id, op_id)
);
create index board_ops_session_rev_idx on board_ops (session_id, rev);

-- Current board document (board.v1) per session and its text summary.
create table boards (
    session_id uuid primary key references sessions (id) on delete cascade,
    rev        bigint not null default 0,
    doc        jsonb not null,
    summary    text not null default '',
    updated_at timestamptz not null default now()
);

-- PNG renders of the board (file under DATA_DIR).
create table board_images (
    id         bigserial primary key,
    session_id uuid not null references sessions (id) on delete cascade,
    rev        bigint not null,
    path       text not null,
    bytes      integer not null check (bytes >= 0),
    created_at timestamptz not null default now()
);
create index board_images_session_idx on board_images (session_id, created_at desc);

-- Scored report (report.v1).
create table reports (
    session_id     uuid primary key references sessions (id) on delete cascade,
    schema_version text not null default 'report.v1',
    report         jsonb not null,
    model          text,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

-- Spend ledger: Fish minutes and Claude calls, used for caps and entitlements.
create table usage_events (
    id                 bigserial primary key,
    identity_id        uuid references identities (id) on delete set null,
    session_id         uuid references sessions (id) on delete set null,
    provider           text not null check (provider in ('fish', 'anthropic')),
    kind               text not null,
    model              text,
    usage_phase        text not null check (usage_phase in ('build', 'judging', 'after')),
    minutes            numeric(10, 3),
    input_tokens       integer,
    output_tokens      integer,
    cache_read_tokens  integer,
    cache_write_tokens integer,
    cost_usd           numeric(12, 6) not null default 0,
    meta               jsonb not null default '{}'::jsonb,
    created_at         timestamptz not null default now()
);
create index usage_events_phase_idx on usage_events (usage_phase, provider, created_at);
create index usage_events_identity_idx on usage_events (identity_id, created_at);
create index usage_events_session_idx on usage_events (session_id);

-- Public scorecard links.
create table shares (
    slug               text primary key,
    session_id         uuid not null references sessions (id) on delete cascade,
    identity_id        uuid not null references identities (id) on delete cascade,
    include_transcript boolean not null default false,
    created_at         timestamptz not null default now(),
    revoked_at         timestamptz
);
create index shares_session_idx on shares (session_id);

-- Plans and minute grants (free, sprint, pro, topup). Checkout comes later.
create table entitlements (
    id            bigserial primary key,
    identity_id   uuid not null references identities (id) on delete cascade,
    plan          text not null check (plan in ('free', 'sprint', 'pro', 'topup')),
    minutes_total integer not null default 0 check (minutes_total >= 0),
    live_rounds   integer,
    source        text not null default 'system',
    starts_at     timestamptz not null default now(),
    expires_at    timestamptz,
    created_at    timestamptz not null default now()
);
create index entitlements_identity_idx on entitlements (identity_id, expires_at);
