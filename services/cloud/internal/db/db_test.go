package db

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tyuan511/fastvibe/services/cloud/internal/testdb"
)

func exec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) error {
	t.Helper()
	_, err := pool.Exec(context.Background(), sql, args...)
	return err
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if err := exec(t, pool, sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

func mustFail(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected an error mentioning %q", want)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("expected an error mentioning %q, got %v", want, err)
	}
}

// fixture inserts one user, one model with a price, and returns their ids.
func fixture(t *testing.T, pool *pgxpool.Pool) (userID, priceID string) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (github_id, github_login) VALUES (1, 'octocat') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	mustExec(t, pool, `INSERT INTO models (id, display_name, default_api, context_window, max_output, max_reserve_micros)
		VALUES ('m', 'M', 'openai-responses', 1000, 100, 1000000)`)
	if err := pool.QueryRow(ctx, `INSERT INTO price_book
		(model_id, effective_from, input, output, cache_read, cache_write_5m, cache_write_1h)
		VALUES ('m', now(), 3000000, 15000000, 300000, 3750000, 6000000) RETURNING id`).Scan(&priceID); err != nil {
		t.Fatal(err)
	}
	return userID, priceID
}

func TestMigrateUpDownUp(t *testing.T) {
	pool := testdb.Fresh(t)
	ctx := context.Background()
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	testdb.DownAll(t, pool)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("re-applying after a full down: %v", err)
	}
}

func TestPriceBookIsAppendOnly(t *testing.T) {
	pool := testdb.Migrated(t)
	fixture(t, pool)
	mustFail(t, exec(t, pool, `UPDATE price_book SET input = 1`), "append-only")
	mustFail(t, exec(t, pool, `DELETE FROM price_book`), "append-only")
}

func TestLedgerRules(t *testing.T) {
	pool := testdb.Migrated(t)
	user, _ := fixture(t, pool)

	mustExec(t, pool, `INSERT INTO ledger_entries (user_id, kind, amount_micros, ref) VALUES ($1, 'redeem', 5000000, 'code-1')`, user)
	// The same ref of the same kind is the same movement of money: refused, not doubled.
	mustFail(t, exec(t, pool, `INSERT INTO ledger_entries (user_id, kind, amount_micros, ref) VALUES ($1, 'redeem', 5000000, 'code-1')`, user), "duplicate key")
	// Signs are fixed per kind.
	mustFail(t, exec(t, pool, `INSERT INTO ledger_entries (user_id, kind, amount_micros, ref) VALUES ($1, 'usage', 10, 'r1')`, user), "check constraint")
	mustFail(t, exec(t, pool, `INSERT INTO ledger_entries (user_id, kind, amount_micros, ref) VALUES ($1, 'redeem', -10, 'code-2')`, user), "check constraint")
	mustFail(t, exec(t, pool, `INSERT INTO ledger_entries (user_id, kind, amount_micros, ref) VALUES ($1, 'grant', 0, 'signup')`, user), "check constraint")
	// An adjustment needs a reason and an author.
	mustFail(t, exec(t, pool, `INSERT INTO ledger_entries (user_id, kind, amount_micros, ref) VALUES ($1, 'adjust', -10, 'a1')`, user), "check constraint")
	mustExec(t, pool, `INSERT INTO ledger_entries (user_id, kind, amount_micros, ref, note, created_by) VALUES ($1, 'adjust', -10, 'a1', 'test', $1)`, user)

	mustFail(t, exec(t, pool, `UPDATE ledger_entries SET amount_micros = 1`), "append-only")
	mustFail(t, exec(t, pool, `DELETE FROM ledger_entries`), "append-only")
}

func TestUsageEventFinalizesOnce(t *testing.T) {
	pool := testdb.Migrated(t)
	user, price := fixture(t, pool)
	const req = "01900000-0000-7000-8000-000000000001"

	mustExec(t, pool, `INSERT INTO usage_events (request_id, user_id, session_id, model_id, price_id, request_api, reserve_micros)
		VALUES ($1, $2, gen_random_uuid(), 'm', $3, 'openai-responses', 500000)`, req, user, price)

	// A final status needs a finish time and a cost.
	mustFail(t, exec(t, pool, `UPDATE usage_events SET status = 'completed' WHERE request_id = $1`, req), "check constraint")
	// The reserve and the price are fixed when the request starts.
	mustFail(t, exec(t, pool, `UPDATE usage_events SET reserve_micros = 1 WHERE request_id = $1`, req), "fixed at start")

	mustExec(t, pool, `UPDATE usage_events SET status = 'completed', usage_source = 'upstream',
		input_tokens = 100, output_tokens = 20, cost_micros = 600, finished_at = now() WHERE request_id = $1`, req)
	mustFail(t, exec(t, pool, `UPDATE usage_events SET cost_micros = 0 WHERE request_id = $1`, req), "already completed")
	mustFail(t, exec(t, pool, `DELETE FROM usage_events WHERE request_id = $1`, req), "never deleted")
}

func TestHeldCannotGoNegative(t *testing.T) {
	pool := testdb.Migrated(t)
	user, _ := fixture(t, pool)
	mustExec(t, pool, `INSERT INTO balances (user_id) VALUES ($1)`, user)
	mustFail(t, exec(t, pool, `UPDATE balances SET held_micros = held_micros - 1 WHERE user_id = $1`, user), "check constraint")
}

func TestVerifiedEmailIsUnique(t *testing.T) {
	pool := testdb.Migrated(t)
	mustExec(t, pool, `INSERT INTO users (github_id, github_login, email, email_verified_at) VALUES (1, 'a', 'Me@Example.com', now())`)
	mustFail(t, exec(t, pool, `INSERT INTO users (github_id, github_login, email, email_verified_at) VALUES (2, 'b', 'me@example.com', now())`), "duplicate key")
	mustFail(t, exec(t, pool, `INSERT INTO users (github_id, github_login, email) VALUES (3, 'c', 'other@example.com')`), "check constraint")
}
