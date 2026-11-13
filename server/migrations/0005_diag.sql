-- Device check results posted from the /diag page (one JSON blob per run, at most 64 KB).
create table diag_results (
    id bigserial primary key,
    identity_id uuid not null references identities (id) on delete cascade,
    created_at timestamptz not null default now(),
    payload jsonb not null
);

create index diag_results_identity_created on diag_results (identity_id, created_at desc);
create index diag_results_created on diag_results (created_at desc);
