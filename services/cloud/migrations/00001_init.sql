-- The first schema: accounts, the model catalog, usage and the money ledger.
-- See docs/cloud-service.md. Money is always bigint micro-USD (1 USD = 1,000,000);
-- prices are micro-USD per 1,000,000 tokens.
--
-- The billing invariants are enforced here, not only in Go: price rows and ledger rows
-- are append-only, a usage row is finalized exactly once, and a ledger entry exists at
-- most once per (user, kind, ref). A bug in the service then fails loudly instead of
-- quietly charging twice.

-- +goose Up

-- +goose StatementBegin
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP;
END
$$;
-- +goose StatementEnd

-- Accounts ------------------------------------------------------------------------

CREATE TABLE users (
    id                uuid PRIMARY KEY DEFAULT uuidv7(),
    role              text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    -- GitHub's numeric id is the identity; the login can be renamed and re-registered.
    github_id         bigint NOT NULL UNIQUE,
    github_login      text NOT NULL,
    avatar_url        text,
    github_created_at timestamptz,
    -- Only GitHub's primary *verified* email is stored; NULL when there is none.
    email             text,
    email_verified_at timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    disabled_at       timestamptz,
    CHECK ((email IS NULL) = (email_verified_at IS NULL))
);
-- One account per verified email, so a future email sign-in can merge on it safely.
CREATE UNIQUE INDEX users_verified_email ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    -- SHA-256 of the opaque token; the token itself is never stored.
    token_hash   bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    kind         text NOT NULL CHECK (kind IN ('web', 'desktop', 'mobile')),
    device_name  text,
    platform     text,
    user_agent   text,
    ip           inet,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz
);
CREATE INDEX sessions_by_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE audit_log (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id    uuid REFERENCES users (id) ON DELETE RESTRICT,
    action     text NOT NULL,
    target     text,
    ip         inet,
    user_agent text,
    meta       jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_by_user ON audit_log (user_id, created_at DESC);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Upstream channels and the public model catalog ------------------------------------

CREATE TABLE channels (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    name          text NOT NULL UNIQUE,
    -- A Bifrost provider type: openai, anthropic, gemini, ... An OpenAI-compatible
    -- relay is a custom provider based on openai, with its own base_url.
    provider_type text NOT NULL,
    base_url      text,
    headers       jsonb NOT NULL DEFAULT '{}',
    proxy_url     text,
    enabled       boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_keys (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    channel_id    uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    -- AES-256-GCM ciphertext; the key encrypting it lives in the environment.
    key_enc       bytea NOT NULL,
    key_last4     text NOT NULL,
    weight        integer NOT NULL DEFAULT 1 CHECK (weight > 0),
    enabled       boolean NOT NULL DEFAULT true,
    last_error    text,
    last_error_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_keys_by_channel ON channel_keys (channel_id);

CREATE TABLE models (
    id                 text PRIMARY KEY,
    display_name       text NOT NULL,
    default_api        text NOT NULL CHECK (default_api IN (
                           'openai-completions', 'openai-responses',
                           'anthropic-messages', 'google-generative-ai')),
    context_window     integer NOT NULL CHECK (context_window > 0),
    max_output         integer NOT NULL CHECK (max_output > 0),
    input_modalities   text[] NOT NULL DEFAULT '{text}',
    thinking_levels    text[] NOT NULL DEFAULT '{}',
    -- Upper bound on what one request may hold against a balance before it runs.
    max_reserve_micros bigint NOT NULL CHECK (max_reserve_micros > 0),
    visible            boolean NOT NULL DEFAULT false,
    sort_order         integer NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_routes (
    model_id       text NOT NULL REFERENCES models (id) ON DELETE CASCADE,
    channel_id     uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    upstream_model text NOT NULL,
    priority       integer NOT NULL DEFAULT 0,
    weight         integer NOT NULL DEFAULT 1 CHECK (weight > 0),
    enabled        boolean NOT NULL DEFAULT true,
    PRIMARY KEY (model_id, channel_id)
);

-- Selling price. Append-only: a change is a new row, so every past request can be
-- re-priced with the exact row it was charged at.
CREATE TABLE price_book (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    model_id       text NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
    effective_from timestamptz NOT NULL,
    input          bigint NOT NULL CHECK (input >= 0),
    output         bigint NOT NULL CHECK (output >= 0),
    cache_read     bigint NOT NULL CHECK (cache_read >= 0),
    cache_write_5m bigint NOT NULL CHECK (cache_write_5m >= 0),
    cache_write_1h bigint NOT NULL CHECK (cache_write_1h >= 0),
    -- Long-context ladder: [{"over": tokens, "input": ..., "output": ..., ...}], ascending.
    tiers          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tiers) = 'array'),
    created_by     uuid REFERENCES users (id) ON DELETE RESTRICT,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (model_id, effective_from)
);
CREATE TRIGGER price_book_append_only BEFORE UPDATE OR DELETE ON price_book
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- What a channel costs us. Used only for reconciliation and margin, never to charge.
CREATE TABLE channel_costs (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    channel_id     uuid NOT NULL REFERENCES channels (id) ON DELETE RESTRICT,
    upstream_model text NOT NULL,
    effective_from timestamptz NOT NULL,
    input          bigint NOT NULL CHECK (input >= 0),
    output         bigint NOT NULL CHECK (output >= 0),
    cache_read     bigint NOT NULL CHECK (cache_read >= 0),
    cache_write_5m bigint NOT NULL CHECK (cache_write_5m >= 0),
    cache_write_1h bigint NOT NULL CHECK (cache_write_1h >= 0),
    tiers          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tiers) = 'array'),
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (channel_id, upstream_model, effective_from)
);
CREATE TRIGGER channel_costs_append_only BEFORE UPDATE OR DELETE ON channel_costs
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Usage ---------------------------------------------------------------------------

-- One row per /llm request. Inserted as pending (with its reserve) before the upstream
-- call, finalized exactly once afterwards. Not partitioned: a partitioned table cannot
-- keep request_id unique on its own.
CREATE TABLE usage_events (
    request_id            uuid PRIMARY KEY,
    user_id               uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    -- No foreign key: expired sessions are deleted, their usage history is not.
    session_id            uuid NOT NULL,
    model_id              text NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
    price_id              uuid NOT NULL REFERENCES price_book (id) ON DELETE RESTRICT,
    request_api           text NOT NULL,
    channel_id            uuid REFERENCES channels (id) ON DELETE RESTRICT,
    status                text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'completed', 'failed', 'aborted', 'lost')),
    usage_source          text CHECK (usage_source IN ('upstream', 'estimated')),
    input_tokens          bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    cache_read_tokens     bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    cache_write_5m_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_5m_tokens >= 0),
    cache_write_1h_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_1h_tokens >= 0),
    output_tokens         bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    -- Display only: already counted inside output_tokens.
    reasoning_tokens      bigint NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
    raw_usage             jsonb,
    reserve_micros        bigint NOT NULL CHECK (reserve_micros >= 0),
    cost_micros           bigint CHECK (cost_micros >= 0),
    attempts              integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    ttfb_ms               integer,
    latency_ms            integer,
    error_code            text,
    started_at            timestamptz NOT NULL DEFAULT now(),
    finished_at           timestamptz,
    CHECK ((status = 'pending') = (finished_at IS NULL)),
    CHECK (status = 'pending' OR cost_micros IS NOT NULL),
    CHECK (status = 'pending' OR status = 'lost' OR status = 'failed' OR usage_source IS NOT NULL)
);
CREATE INDEX usage_events_by_user ON usage_events (user_id, started_at DESC);
CREATE INDEX usage_events_pending ON usage_events (started_at) WHERE status = 'pending';

-- +goose StatementBegin
CREATE FUNCTION usage_events_finalize_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'usage_events rows are never deleted';
    END IF;
    IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'usage_events % is already %', OLD.request_id, OLD.status;
    END IF;
    IF NEW.request_id IS DISTINCT FROM OLD.request_id
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.session_id IS DISTINCT FROM OLD.session_id
        OR NEW.model_id IS DISTINCT FROM OLD.model_id
        OR NEW.price_id IS DISTINCT FROM OLD.price_id
        OR NEW.reserve_micros IS DISTINCT FROM OLD.reserve_micros
        OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
        RAISE EXCEPTION 'usage_events %: identity, price and reserve are fixed at start', OLD.request_id;
    END IF;
    RETURN NEW;
END
$$;
-- +goose StatementEnd
CREATE TRIGGER usage_events_finalize_once BEFORE UPDATE OR DELETE ON usage_events
    FOR EACH ROW EXECUTE FUNCTION usage_events_finalize_once();

-- One row per upstream attempt (fallbacks included): our cost, not the user's charge.
CREATE TABLE usage_attempts (
    request_id     uuid NOT NULL REFERENCES usage_events (request_id) ON DELETE RESTRICT,
    attempt        integer NOT NULL CHECK (attempt >= 1),
    channel_id     uuid NOT NULL REFERENCES channels (id) ON DELETE RESTRICT,
    upstream_model text NOT NULL,
    status         text NOT NULL CHECK (status IN ('completed', 'failed', 'aborted')),
    raw_usage      jsonb,
    cost_micros    bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
    started_at     timestamptz NOT NULL,
    finished_at    timestamptz NOT NULL,
    PRIMARY KEY (request_id, attempt)
);

-- Daily rollup the console charts read. Days are UTC.
CREATE TABLE usage_daily (
    user_id               uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    day                   date NOT NULL,
    model_id              text NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
    session_id            uuid NOT NULL,
    requests              bigint NOT NULL DEFAULT 0,
    input_tokens          bigint NOT NULL DEFAULT 0,
    cache_read_tokens     bigint NOT NULL DEFAULT 0,
    cache_write_tokens    bigint NOT NULL DEFAULT 0,
    output_tokens         bigint NOT NULL DEFAULT 0,
    cost_micros           bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, model_id, session_id)
);

-- Money -----------------------------------------------------------------------------

-- Every movement of money, append-only. A balance is the sum of its user's rows.
CREATE TABLE ledger_entries (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    kind          text NOT NULL CHECK (kind IN ('usage', 'redeem', 'grant', 'topup', 'refund', 'adjust')),
    amount_micros bigint NOT NULL CHECK (amount_micros <> 0),
    -- usage → request_id; redeem → redeem_codes.id; topup/refund → payment event id;
    -- grant → 'signup'; adjust → the audit_log id of the admin action.
    ref           text NOT NULL,
    note          text,
    created_by    uuid REFERENCES users (id) ON DELETE RESTRICT,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, kind, ref),
    CHECK (CASE kind
        WHEN 'usage'  THEN amount_micros < 0
        WHEN 'refund' THEN amount_micros < 0
        WHEN 'adjust' THEN note IS NOT NULL AND created_by IS NOT NULL
        ELSE amount_micros > 0
    END)
);
CREATE INDEX ledger_entries_by_user ON ledger_entries (user_id, created_at DESC);
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Cached sum of the ledger plus what pending requests hold. Updated in the same
-- transaction as the ledger row; the daily reconciliation recomputes both.
CREATE TABLE balances (
    user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
    amount_micros bigint NOT NULL DEFAULT 0,
    held_micros   bigint NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE redeem_codes (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    code_hash     bytea NOT NULL UNIQUE CHECK (length(code_hash) = 32),
    amount_micros bigint NOT NULL CHECK (amount_micros > 0),
    batch         text,
    created_by    uuid REFERENCES users (id) ON DELETE RESTRICT,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz,
    used_by       uuid REFERENCES users (id) ON DELETE RESTRICT,
    used_at       timestamptz,
    voided_at     timestamptz,
    CHECK ((used_by IS NULL) = (used_at IS NULL)),
    CHECK (used_at IS NULL OR voided_at IS NULL)
);

-- +goose Down
DROP TABLE redeem_codes;
DROP TABLE balances;
DROP TABLE ledger_entries;
DROP TABLE usage_daily;
DROP TABLE usage_attempts;
DROP TABLE usage_events;
DROP FUNCTION usage_events_finalize_once();
DROP TABLE channel_costs;
DROP TABLE price_book;
DROP TABLE model_routes;
DROP TABLE models;
DROP TABLE channel_keys;
DROP TABLE channels;
DROP TABLE audit_log;
DROP TABLE sessions;
DROP TABLE users;
DROP FUNCTION forbid_mutation();
