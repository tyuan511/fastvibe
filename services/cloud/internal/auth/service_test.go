package auth

import (
	"context"
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/tyuan511/fastvibe/services/cloud/internal/auth/authtest"
	"github.com/tyuan511/fastvibe/services/cloud/internal/config"
	"github.com/tyuan511/fastvibe/services/cloud/internal/testdb"
)

// ---- harness -------------------------------------------------------------------------

type harness struct {
	t    *testing.T
	svc  *Service
	pool *pgxpool.Pool
	gh   *authtest.GitHub
}

type option func(*config.Config)

func newHarness(t *testing.T, opts ...option) *harness {
	t.Helper()
	pool := testdb.Migrated(t)
	gh := authtest.New(t)
	cfg := &config.Config{
		Env:          "development",
		PublicOrigin: "http://localhost:3000",
		GitHub:       config.GitHub{ClientID: authtest.ClientID, ClientSecret: authtest.ClientSecret},
		Session:      config.Session{WebTTL: 30 * 24 * time.Hour, CacheTTL: 0},
	}
	for _, o := range opts {
		o(cfg)
	}
	client := NewGitHub(authtest.ClientID, authtest.ClientSecret)
	client.OAuthBase, client.APIBase = gh.URL, gh.URL
	return &harness{t: t, svc: New(pool, cfg, client, zap.NewNop()), pool: pool, gh: gh}
}

func withCache(ttl time.Duration) option { return func(c *config.Config) { c.Session.CacheTTL = ttl } }
func withAdmins(ids ...int64) option     { return func(c *config.Config) { c.Admin.GitHubIDs = ids } }

// account registers a GitHub account and returns a fresh one-time code for it.
func (h *harness) account(a authtest.Account) string { return h.gh.Issue(a) }

type attempt struct {
	state, stateCookie, challenge string
}

// begin runs BeginLogin and unpacks what the browser would see.
func (h *harness) begin(returnTo string) attempt {
	h.t.Helper()
	authURL, cookie, err := h.svc.BeginLogin(returnTo)
	if err != nil {
		h.t.Fatal(err)
	}
	u, err := url.Parse(authURL)
	if err != nil {
		h.t.Fatal(err)
	}
	q := u.Query()
	if u.Host != strings.TrimPrefix(h.gh.URL, "http://") || u.Path != "/login/oauth/authorize" {
		h.t.Errorf("authorize URL points at %s%s", u.Host, u.Path)
	}
	want := map[string]string{
		"client_id": "client-id", "scope": "read:user user:email", "code_challenge_method": "S256",
		"redirect_uri": "http://localhost:3000/api/auth/github/callback",
	}
	for k, v := range want {
		if q.Get(k) != v {
			h.t.Errorf("authorize %s = %q, want %q", k, q.Get(k), v)
		}
	}
	return attempt{state: q.Get("state"), stateCookie: cookie, challenge: q.Get("code_challenge")}
}

// signIn is a whole successful visit: begin, GitHub approves, callback.
func (h *harness) signIn(a authtest.Account) LoginResult {
	h.t.Helper()
	res, err := h.tryLogin(a, "/console")
	if err != nil {
		h.t.Fatalf("sign in as %s: %v", a.Login, err)
	}
	return res
}

func (h *harness) tryLogin(a authtest.Account, returnTo string) (LoginResult, error) {
	h.t.Helper()
	at := h.begin(returnTo)
	a.Challenge = at.challenge
	code := h.account(a)
	return h.svc.CompleteLogin(context.Background(), CompleteInput{
		Code: code, State: at.state, StateCookie: at.stateCookie, Client: Client{UserAgent: "test-agent"},
	})
}

func (h *harness) count(sql string, args ...any) int {
	h.t.Helper()
	var n int
	if err := h.pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

func (h *harness) exec(sql string, args ...any) {
	h.t.Helper()
	if _, err := h.pool.Exec(context.Background(), sql, args...); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) email(userID uuid.UUID) *string {
	h.t.Helper()
	var e *string
	if err := h.pool.QueryRow(context.Background(), `SELECT email FROM users WHERE id = $1`, userID).Scan(&e); err != nil {
		h.t.Fatal(err)
	}
	return e
}

func octocat() authtest.Account {
	return authtest.Account{ID: 583231, Login: "octocat", Emails: []authtest.Email{
		{Email: "Octo@Example.com", Primary: true, Verified: true},
		{Email: "other@example.com", Verified: true},
	}}
}

// ---- tests ---------------------------------------------------------------------------

func TestFirstSignInCreatesEverythingTheBillingCodeWillAssume(t *testing.T) {
	h := newHarness(t)
	res := h.signIn(octocat())

	if h.count(`SELECT count(*) FROM users WHERE github_id = 583231`) != 1 {
		t.Fatal("user not created")
	}
	if h.count(`SELECT count(*) FROM balances WHERE user_id = $1 AND amount_micros = 0 AND held_micros = 0`, res.UserID) != 1 {
		t.Error("a new account needs its balance row, so no later code has to create it racily")
	}
	if h.count(`SELECT count(*) FROM audit_log WHERE user_id = $1 AND action = 'login' AND meta->>'new_user' = 'true'`, res.UserID) != 1 {
		t.Error("first sign-in should be audited as a new user")
	}
	if res.ReturnTo != "/console" || res.ExpiresAt.Before(time.Now().Add(29*24*time.Hour)) {
		t.Errorf("result = %+v", res)
	}

	p, err := h.svc.Authenticate(context.Background(), res.Token)
	if err != nil {
		t.Fatal(err)
	}
	if p.UserID != res.UserID || p.Login != "octocat" || p.Role != "user" || p.Kind != "web" {
		t.Errorf("principal = %+v", p)
	}

	// The token itself is never stored, only its hash.
	if h.count(`SELECT count(*) FROM sessions WHERE token_hash = $1`, hashToken(res.Token)) != 1 ||
		h.count(`SELECT count(*) FROM sessions WHERE encode(token_hash, 'escape') LIKE '%fvs_%'`) != 0 {
		t.Error("session should be stored by hash")
	}
}

func TestSecondSignInKeepsTheAccountAndFollowsRenames(t *testing.T) {
	h := newHarness(t)
	first := h.signIn(octocat())

	renamed := octocat()
	renamed.Login = "octocat-renamed"
	second := h.signIn(renamed)

	if second.UserID != first.UserID {
		t.Fatal("same GitHub id must be the same account, whatever the login says now")
	}
	if h.count(`SELECT count(*) FROM users`) != 1 || h.count(`SELECT count(*) FROM sessions WHERE user_id = $1`, first.UserID) != 2 {
		t.Error("expected one user and two sessions")
	}
	if h.count(`SELECT count(*) FROM users WHERE github_login = 'octocat-renamed'`) != 1 {
		t.Error("login should follow GitHub")
	}
	// A different person taking over the old login name is a different account.
	h.signIn(authtest.Account{ID: 999, Login: "octocat"})
	if h.count(`SELECT count(*) FROM users`) != 2 {
		t.Error("a new GitHub id with a recycled login must not become the old account")
	}
}

func TestSignInChecksStateAndPKCE(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	complete := func(at attempt, code, state string) error {
		_, err := h.svc.CompleteLogin(ctx, CompleteInput{Code: code, State: state, StateCookie: at.stateCookie})
		return err
	}
	acct := func(at attempt) string { a := octocat(); a.Challenge = at.challenge; return h.account(a) }

	at := h.begin("/console")
	if err := complete(at, acct(at), "not-the-state"); !errors.Is(err, ErrInvalidState) {
		t.Errorf("wrong state: %v", err)
	}
	if err := complete(attempt{stateCookie: "garbage"}, acct(at), at.state); !errors.Is(err, ErrInvalidState) {
		t.Errorf("garbage cookie: %v", err)
	}
	if err := complete(attempt{}, acct(at), at.state); !errors.Is(err, ErrInvalidState) {
		t.Errorf("missing cookie: %v", err)
	}
	if err := complete(at, "", at.state); !errors.Is(err, ErrInvalidState) {
		t.Errorf("missing code: %v", err)
	}

	// A state from one visit is no use with the cookie of another.
	other := h.begin("/console")
	if err := complete(other, acct(other), at.state); !errors.Is(err, ErrInvalidState) {
		t.Errorf("state from another visit: %v", err)
	}

	// Taking longer than the window.
	late := h.begin("/console")
	h.svc.now = func() time.Time { return time.Now().Add(stateTTL + time.Minute) }
	if err := complete(late, acct(late), late.state); !errors.Is(err, ErrInvalidState) {
		t.Errorf("expired state: %v", err)
	}
	h.svc.now = time.Now

	// The verifier we send must be the one the challenge was made from: the fake rejects
	// a code issued against a different challenge.
	good := h.begin("/console")
	stranger := h.begin("/console")
	a := octocat()
	a.Challenge = stranger.challenge
	if err := complete(good, h.account(a), good.state); !errors.Is(err, ErrCodeRejected) {
		t.Errorf("PKCE mismatch: %v", err)
	}

	// A code works once.
	fresh := h.begin("/console")
	code := acct(fresh)
	if err := complete(fresh, code, fresh.state); err != nil {
		t.Fatal(err)
	}
	again := h.begin("/console")
	if err := complete(again, code, again.state); !errors.Is(err, ErrCodeRejected) {
		t.Errorf("reused code: %v", err)
	}

	if h.count(`SELECT count(*) FROM sessions`) != 1 {
		t.Error("only the one valid sign-in may have opened a session")
	}
}

func TestGitHubDownIsReportedAsUnavailable(t *testing.T) {
	h := newHarness(t)
	at := h.begin("/console")
	h.gh.Close()
	_, err := h.svc.CompleteLogin(context.Background(), CompleteInput{Code: "x", State: at.state, StateCookie: at.stateCookie})
	if !errors.Is(err, ErrGitHubUnavailable) {
		t.Errorf("got %v", err)
	}
}

func TestReturnToSurvivesTheRoundTripSanitised(t *testing.T) {
	h := newHarness(t)
	for in, want := range map[string]string{
		"/zh/console/usage?range=7d": "/zh/console/usage?range=7d",
		"//evil.example/x":           DefaultReturnTo,
		"https://evil.example":       DefaultReturnTo,
		"/api/me":                    DefaultReturnTo,
		"":                           DefaultReturnTo,
	} {
		res, err := h.tryLogin(octocat(), in)
		if err != nil {
			t.Fatal(err)
		}
		if res.ReturnTo != want {
			t.Errorf("return_to %q → %q, want %q", in, res.ReturnTo, want)
		}
	}
}

func TestEmailComesOnlyFromGitHubsVerifiedPrimary(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	res := h.signIn(octocat())
	if e := h.email(res.UserID); e == nil || *e != "octo@example.com" {
		t.Fatalf("expected the verified primary, lowercased; got %v (the public profile email must not be used)", e)
	}

	// Primary but unverified: no email.
	unverified := authtest.Account{ID: 2, Login: "unverified", Emails: []authtest.Email{{Email: "u@example.com", Primary: true, Verified: false}}}
	if e := h.email(h.signIn(unverified).UserID); e != nil {
		t.Errorf("unverified email stored: %v", *e)
	}

	// Someone else already holds that verified address: sign-in works, the address is
	// not shared, and the conflict is on record.
	thief := authtest.Account{ID: 3, Login: "thief", Emails: []authtest.Email{{Email: "octo@example.com", Primary: true, Verified: true}}}
	thiefRes := h.signIn(thief)
	if e := h.email(thiefRes.UserID); e != nil {
		t.Errorf("an address held by another account was written: %v", *e)
	}
	if e := h.email(res.UserID); e == nil || *e != "octo@example.com" {
		t.Error("the original holder lost the address")
	}
	if h.count(`SELECT count(*) FROM audit_log WHERE user_id = $1 AND action = 'email_conflict'`, thiefRes.UserID) != 1 {
		t.Error("the conflict should be audited")
	}
	if _, err := h.svc.Authenticate(ctx, thiefRes.Token); err != nil {
		t.Errorf("a conflicting email must not block the session: %v", err)
	}

	// Changed primary follows.
	moved := octocat()
	moved.Emails = []authtest.Email{{Email: "new@example.com", Primary: true, Verified: true}}
	h.signIn(moved)
	if e := h.email(res.UserID); e == nil || *e != "new@example.com" {
		t.Errorf("email should follow GitHub, got %v", e)
	}

	// GitHub failing to list emails must not wipe what we hold.
	flaky := octocat()
	flaky.EmailsErr = true
	h.signIn(flaky)
	if e := h.email(res.UserID); e == nil || *e != "new@example.com" {
		t.Errorf("a failed email lookup changed the stored email to %v", e)
	}

	// Verification withdrawn: cleared.
	gone := octocat()
	gone.Emails = []authtest.Email{{Email: "new@example.com", Primary: true, Verified: false}}
	h.signIn(gone)
	if e := h.email(res.UserID); e != nil {
		t.Errorf("an address GitHub no longer vouches for stayed: %v", *e)
	}
}

func TestAdminComesOnlyFromTheConfiguredList(t *testing.T) {
	h := newHarness(t, withAdmins(583231))
	ctx := context.Background()

	admin, err := h.svc.Authenticate(ctx, h.signIn(octocat()).Token)
	if err != nil || !admin.IsAdmin() {
		t.Fatalf("configured id should be admin: %+v %v", admin, err)
	}
	if h.count(`SELECT count(*) FROM audit_log WHERE action = 'admin_granted'`) != 1 {
		t.Error("promotion should be audited")
	}
	h.signIn(octocat())
	if h.count(`SELECT count(*) FROM audit_log WHERE action = 'admin_granted'`) != 1 {
		t.Error("promotion is recorded once, not at every sign-in")
	}

	user, err := h.svc.Authenticate(ctx, h.signIn(authtest.Account{ID: 5, Login: "someone"}).Token)
	if err != nil || user.IsAdmin() {
		t.Errorf("an id not on the list must stay a user: %+v %v", user, err)
	}
}

func TestDisabledAccounts(t *testing.T) {
	h := newHarness(t, withCache(30*time.Second))
	ctx := context.Background()
	res := h.signIn(octocat())
	if _, err := h.svc.Authenticate(ctx, res.Token); err != nil {
		t.Fatal(err)
	}

	h.exec(`UPDATE users SET disabled_at = now() WHERE id = $1`, res.UserID)

	if _, err := h.tryLogin(octocat(), "/console"); !errors.Is(err, ErrDisabled) {
		t.Errorf("disabled account signed in: %v", err)
	}
	if h.count(`SELECT count(*) FROM sessions WHERE user_id = $1`, res.UserID) != 1 {
		t.Error("a refused sign-in opened a session")
	}
	if h.count(`SELECT count(*) FROM audit_log WHERE action = 'login_refused'`) != 1 {
		t.Error("the refusal should be audited (and must survive: it commits)")
	}

	// The documented bound: the cached verdict outlives the disabling by up to the cache TTL.
	if _, err := h.svc.Authenticate(ctx, res.Token); err != nil {
		t.Errorf("within the cache window the old verdict stands: %v", err)
	}
	h.svc.now = func() time.Time { return time.Now().Add(31 * time.Second) }
	if _, err := h.svc.Authenticate(ctx, res.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("after the cache window a disabled account's session must die: %v", err)
	}
}

func TestAuthenticateRejectsWhatItShould(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	res := h.signIn(octocat())

	unknown, _ := newToken()
	for name, tok := range map[string]string{"empty": "", "garbage": "nope", "no prefix": strings.TrimPrefix(res.Token, tokenPrefix) + "xxxx", "unknown": unknown, "truncated": res.Token[:20]} {
		if _, err := h.svc.Authenticate(ctx, tok); !errors.Is(err, ErrUnauthenticated) {
			t.Errorf("%s token: %v", name, err)
		}
	}

	h.exec(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, res.UserID)
	if _, err := h.svc.Authenticate(ctx, res.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("expired session: %v", err)
	}
}

func TestUsedSessionsSlideForward(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	res := h.signIn(octocat())

	// Used a moment ago: the expiry is left alone (no write per request).
	var before time.Time
	_ = h.pool.QueryRow(ctx, `SELECT expires_at FROM sessions WHERE user_id = $1`, res.UserID).Scan(&before)
	if _, err := h.svc.Authenticate(ctx, res.Token); err != nil {
		t.Fatal(err)
	}
	var after time.Time
	_ = h.pool.QueryRow(ctx, `SELECT expires_at FROM sessions WHERE user_id = $1`, res.UserID).Scan(&after)
	if !after.Equal(before) {
		t.Error("a session used seconds ago should not be rewritten")
	}

	// Idle for an hour, then used: pushed a full TTL out from now.
	h.exec(`UPDATE sessions SET last_used_at = now() - interval '1 hour', expires_at = now() + interval '1 day' WHERE user_id = $1`, res.UserID)
	if _, err := h.svc.Authenticate(ctx, res.Token); err != nil {
		t.Fatal(err)
	}
	if h.count(`SELECT count(*) FROM sessions WHERE user_id = $1 AND expires_at > now() + interval '29 days'`, res.UserID) != 1 {
		t.Error("a session in use should be extended to a full TTL")
	}
}

func TestLogoutAndRevocation(t *testing.T) {
	h := newHarness(t, withCache(time.Minute)) // the cache must not keep a revoked token alive here
	ctx := context.Background()
	me := h.signIn(octocat())
	myOther := h.signIn(octocat())
	stranger := h.signIn(authtest.Account{ID: 7, Login: "stranger"})

	for _, tok := range []string{me.Token, myOther.Token} {
		if _, err := h.svc.Authenticate(ctx, tok); err != nil { // warm the cache
			t.Fatal(err)
		}
	}

	list, err := h.svc.ListSessions(ctx, me.UserID)
	if err != nil || len(list) != 2 {
		t.Fatalf("expected my two sessions, got %d (%v)", len(list), err)
	}

	// Someone else's session id looks exactly like one that does not exist.
	var strangerSession uuid.UUID
	_ = h.pool.QueryRow(ctx, `SELECT id FROM sessions WHERE user_id = $1`, stranger.UserID).Scan(&strangerSession)
	if err := h.svc.RevokeSession(ctx, me.UserID, strangerSession, Client{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("revoking another user's session: %v", err)
	}
	if _, err := h.svc.Authenticate(ctx, stranger.Token); err != nil {
		t.Error("the stranger's session must be untouched")
	}

	// Revoke one of mine by id: gone at once, despite the cache.
	if err := h.svc.RevokeSession(ctx, me.UserID, list[0].ID, Client{}); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.RevokeSession(ctx, me.UserID, list[0].ID, Client{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("revoking twice: %v", err)
	}
	live := 0
	for _, tok := range []string{me.Token, myOther.Token} {
		if _, err := h.svc.Authenticate(ctx, tok); err == nil {
			live++
		}
	}
	if live != 1 {
		t.Errorf("exactly one of my two sessions should survive, %d did", live)
	}

	// Logout by token, twice (the second is not an error).
	survivor := me.Token
	if _, err := h.svc.Authenticate(ctx, survivor); err != nil {
		survivor = myOther.Token
	}
	if err := h.svc.Logout(ctx, survivor, Client{}); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Logout(ctx, survivor, Client{}); err != nil {
		t.Errorf("logging out twice: %v", err)
	}
	if _, err := h.svc.Authenticate(ctx, survivor); !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("a logged-out token still works: %v", err)
	}
	if left, _ := h.svc.ListSessions(ctx, me.UserID); len(left) != 0 {
		t.Errorf("revoked sessions are still listed: %d", len(left))
	}
}

func TestPurgeKeepsNinetyDaysOfHistory(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	res := h.signIn(octocat())
	live := h.signIn(octocat())

	insert := func(expires, revoked string) {
		tok, _ := newToken()
		h.exec(`INSERT INTO sessions (user_id, token_hash, kind, expires_at, revoked_at)
			VALUES ($1, $2, 'web', now() + $3::interval, CASE WHEN $4 = '' THEN NULL ELSE now() + $4::interval END)`,
			res.UserID, hashToken(tok), expires, revoked)
	}
	insert("-100 days", "")        // expired long ago: purged
	insert("30 days", "-100 days") // revoked long ago: purged
	insert("-10 days", "")         // expired recently: kept for support
	insert("30 days", "-1 day")    // revoked recently: kept

	n, err := h.svc.Purge(ctx)
	if err != nil || n != 2 {
		t.Fatalf("purged %d (%v), want 2", n, err)
	}
	if _, err := h.svc.Authenticate(ctx, live.Token); err != nil {
		t.Error("a live session must survive the purge")
	}
	if h.count(`SELECT count(*) FROM sessions`) != 4 {
		t.Error("recent dead sessions should still be there")
	}
}

func TestSafeReturnTo(t *testing.T) {
	ok := []string{"/", "/console", "/zh/console/usage?range=7d", "/en/login#x"}
	bad := []string{
		"", "console", "//evil.example", "///evil.example", "/\\evil.example", "/x\\y", "https://evil.example",
		"javascript:alert(1)", "/ok\r\nSet-Cookie: x=1", "/ok\x00", "/api/me", "/api/auth/logout", "/llm/v1/models",
		"/" + strings.Repeat("a", 600),
	}
	for _, in := range ok {
		if got := SafeReturnTo(in); got != in {
			t.Errorf("SafeReturnTo(%q) = %q, want it kept", in, got)
		}
	}
	for _, in := range bad {
		if got := SafeReturnTo(in); got != DefaultReturnTo {
			t.Errorf("SafeReturnTo(%q) = %q, want %q", in, got, DefaultReturnTo)
		}
	}
}

func TestTokens(t *testing.T) {
	seen := map[string]bool{}
	for range 50 {
		tok, err := newToken()
		if err != nil {
			t.Fatal(err)
		}
		if !wellFormed(tok) || len(tok) != tokenLen {
			t.Fatalf("token %q is not the shape wellFormed expects", tok)
		}
		if _, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(tok, tokenPrefix)); err != nil {
			t.Fatalf("token body is not base64url: %v", err)
		}
		if seen[tok] {
			t.Fatal("duplicate token")
		}
		seen[tok] = true
	}
}

func TestTokenCache(t *testing.T) {
	c := newTokenCache(time.Minute)
	now := time.Now()
	h := hashToken("a")
	p := Principal{Login: "x"}

	if _, ok := c.get(h, now); ok {
		t.Fatal("empty cache answered")
	}
	c.put(h, p, now)
	if got, ok := c.get(h, now.Add(59*time.Second)); !ok || got.Login != "x" {
		t.Error("entry should be served within the TTL")
	}
	if _, ok := c.get(h, now.Add(61*time.Second)); ok {
		t.Error("entry should lapse after the TTL")
	}
	c.put(h, p, now)
	c.delete(h)
	if _, ok := c.get(h, now); ok {
		t.Error("deleted entry served")
	}

	off := newTokenCache(0)
	off.put(h, p, now)
	if _, ok := off.get(h, now); ok {
		t.Error("a zero TTL means no caching")
	}
}
