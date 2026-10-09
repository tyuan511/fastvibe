package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"go.uber.org/zap"

	"github.com/tyuan511/fastvibe/services/cloud/internal/auth"
	"github.com/tyuan511/fastvibe/services/cloud/internal/auth/authtest"
	"github.com/tyuan511/fastvibe/services/cloud/internal/config"
	"github.com/tyuan511/fastvibe/services/cloud/internal/testdb"
)

const httpsOrigin = "https://app.fastvibe.dev"

type authEnv struct {
	t      *testing.T
	app    *fiber.App
	svc    *auth.Service
	gh     *authtest.GitHub
	origin string
	exec   func(sql string, args ...any)
}

func newAuthEnv(t *testing.T, origin string, githubConfigured bool) *authEnv {
	t.Helper()
	pool := testdb.Migrated(t)
	gh := authtest.New(t)
	cfg := &config.Config{
		Env:          "development",
		PublicOrigin: origin,
		HTTP:         config.HTTP{BodyLimit: 1 << 20},
		Session:      config.Session{WebTTL: 30 * 24 * time.Hour},
	}
	if githubConfigured {
		cfg.GitHub = config.GitHub{ClientID: authtest.ClientID, ClientSecret: authtest.ClientSecret}
	}
	client := auth.NewGitHub(authtest.ClientID, authtest.ClientSecret)
	client.OAuthBase, client.APIBase = gh.URL, gh.URL
	svc := auth.New(pool, cfg, client, zap.NewNop())
	app := New(Deps{Config: cfg, DB: pool, Log: zap.NewNop(), Auth: svc})
	return &authEnv{
		t: t, app: app, svc: svc, gh: gh, origin: origin,
		exec: func(sql string, args ...any) {
			t.Helper()
			if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
				t.Fatal(err)
			}
		},
	}
}

// browser is a cookie jar that applies Set-Cookie the way a browser would: a cookie with
// Max-Age <= 0 deletes, and nothing else is remembered.
type browser struct {
	env     *authEnv
	cookies map[string]string
}

func (e *authEnv) browser() *browser { return &browser{env: e, cookies: map[string]string{}} }

type reply struct {
	*http.Response
	body []byte
}

func (r reply) json() map[string]any {
	var m map[string]any
	_ = json.Unmarshal(r.body, &m)
	return m
}

func (r reply) setCookie(name string) *http.Cookie {
	for _, c := range r.Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func (b *browser) do(method, path string, header map[string]string) reply {
	b.env.t.Helper()
	req := httptest.NewRequest(method, path, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	for name, value := range b.cookies {
		req.AddCookie(&http.Cookie{Name: name, Value: value})
	}
	resp, err := b.env.app.Test(req)
	if err != nil {
		b.env.t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	for _, c := range resp.Cookies() {
		if c.MaxAge < 0 || c.Value == "" {
			delete(b.cookies, c.Name)
		} else {
			b.cookies[c.Name] = c.Value
		}
	}
	return reply{Response: resp, body: body}
}

// sameOrigin is what a page on our own site adds to its fetches.
func (b *browser) sameOrigin() map[string]string { return map[string]string{"Origin": b.env.origin} }

// signIn walks start → GitHub → callback and returns the callback's reply.
func (b *browser) signIn(acct authtest.Account, returnTo string) reply {
	b.env.t.Helper()
	start := b.do(http.MethodGet, "/api/auth/github/start?return_to="+url.QueryEscape(returnTo), nil)
	if start.StatusCode != http.StatusFound {
		b.env.t.Fatalf("start: %d %s", start.StatusCode, start.body)
	}
	loc, err := url.Parse(start.Header.Get("Location"))
	if err != nil {
		b.env.t.Fatal(err)
	}
	acct.Challenge = loc.Query().Get("code_challenge")
	code := b.env.gh.Issue(acct)
	return b.do(http.MethodGet, "/api/auth/github/callback?code="+code+"&state="+url.QueryEscape(loc.Query().Get("state")), nil)
}

func (b *browser) sessionCookieName() string {
	if strings.HasPrefix(b.env.origin, "https://") {
		return "__Host-fv_session"
	}
	return "fv_session"
}

func octocat() authtest.Account {
	return authtest.Account{ID: 583231, Login: "octocat", Emails: []authtest.Email{{Email: "Octo@Example.com", Primary: true, Verified: true}}}
}

func errCode(r reply) string {
	e, _ := r.json()["error"].(map[string]any)
	code, _ := e["code"].(string)
	return code
}

// ---- tests ---------------------------------------------------------------------------

func TestStartSendsTheBrowserToGitHub(t *testing.T) {
	e := newAuthEnv(t, httpsOrigin, true)
	b := e.browser()
	r := b.do(http.MethodGet, "/api/auth/github/start?return_to=/zh/console", nil)

	if r.StatusCode != http.StatusFound {
		t.Fatalf("status %d", r.StatusCode)
	}
	loc, _ := url.Parse(r.Header.Get("Location"))
	if q := loc.Query(); q.Get("redirect_uri") != httpsOrigin+"/api/auth/github/callback" ||
		q.Get("code_challenge_method") != "S256" || q.Get("state") == "" || q.Get("code_challenge") == "" {
		t.Errorf("authorize URL: %s", loc)
	}
	c := r.setCookie("__Host-fv_oauth")
	if c == nil {
		t.Fatal("no state cookie")
	}
	// __Host- demands Secure, Path=/ and no Domain; HttpOnly keeps it from page script;
	// Lax (not Strict) lets it come back on the redirect from github.com.
	if !c.Secure || !c.HttpOnly || c.Path != "/" || c.Domain != "" || c.SameSite != http.SameSiteLaxMode || c.MaxAge != 600 {
		t.Errorf("state cookie attributes: %+v", c)
	}
	if r.Header.Get("Cache-Control") != "no-store" {
		t.Error("the redirect must not be cached")
	}
}

func TestStartWithoutGitHubCredentials(t *testing.T) {
	e := newAuthEnv(t, "http://localhost:3000", false)
	r := e.browser().do(http.MethodGet, "/api/auth/github/start", nil)
	if r.StatusCode != http.StatusServiceUnavailable || errCode(r) != "github_not_configured" {
		t.Errorf("%d %s", r.StatusCode, r.body)
	}
}

func TestFullSignInOverHTTPS(t *testing.T) {
	e := newAuthEnv(t, httpsOrigin, true)
	b := e.browser()
	r := b.signIn(octocat(), "/zh/console/usage")

	if r.StatusCode != http.StatusFound || r.Header.Get("Location") != "/zh/console/usage" {
		t.Fatalf("callback: %d → %q", r.StatusCode, r.Header.Get("Location"))
	}
	if r.Header.Get("Referrer-Policy") != "no-referrer" || r.Header.Get("Cache-Control") != "no-store" {
		t.Error("the callback URL carries a one-time code: no Referer, no caching")
	}
	c := r.setCookie("__Host-fv_session")
	if c == nil {
		t.Fatal("no session cookie")
	}
	if !c.Secure || !c.HttpOnly || c.Path != "/" || c.Domain != "" || c.SameSite != http.SameSiteLaxMode || c.MaxAge != 30*24*3600 {
		t.Errorf("session cookie attributes: %+v", c)
	}
	if !strings.HasPrefix(c.Value, "fvs_") {
		t.Errorf("session token = %q", c.Value)
	}
	if gone := r.setCookie("__Host-fv_oauth"); gone == nil || gone.MaxAge >= 0 {
		t.Error("the one-time state cookie should be cleared")
	}
	if _, left := b.cookies["__Host-fv_oauth"]; left {
		t.Error("state cookie survived the callback")
	}

	me := b.do(http.MethodGet, "/api/me", nil)
	if me.StatusCode != http.StatusOK {
		t.Fatalf("/api/me: %d %s", me.StatusCode, me.body)
	}
	got := me.json()
	if got["login"] != "octocat" || got["email"] != "octo@example.com" || got["role"] != "user" ||
		got["id"] == "" || got["avatar_url"] != "https://avatars.example/octocat" {
		t.Errorf("/api/me = %v", got)
	}
	if me.Header.Get("Cache-Control") != "no-store" {
		t.Error("account data must not be cached")
	}
	if me.setCookie("__Host-fv_session") == nil {
		t.Error("a cookie-authenticated request should slide the cookie forward with the session")
	}
}

func TestSignInOverPlainHTTPInDevelopment(t *testing.T) {
	e := newAuthEnv(t, "http://localhost:3000", true)
	b := e.browser()
	r := b.signIn(octocat(), "/")
	c := r.setCookie("fv_session")
	if c == nil || c.Secure || !c.HttpOnly {
		t.Fatalf("plain-http dev uses an unprefixed, non-Secure cookie: %+v", c)
	}
	if b.do(http.MethodGet, "/api/me", nil).StatusCode != http.StatusOK {
		t.Error("session should work")
	}
}

func TestFailedSignInsGoBackToTheLoginPage(t *testing.T) {
	e := newAuthEnv(t, httpsOrigin, true)

	check := func(name string, r reply, want string) {
		t.Helper()
		if r.StatusCode != http.StatusFound || r.Header.Get("Location") != "/login?error="+want {
			t.Errorf("%s: %d → %q, want /login?error=%s", name, r.StatusCode, r.Header.Get("Location"), want)
		}
		if r.setCookie("__Host-fv_session") != nil {
			t.Errorf("%s: a failed sign-in set a session cookie", name)
		}
	}

	b := e.browser()
	check("no state cookie", b.do(http.MethodGet, "/api/auth/github/callback?code=x&state=y", nil), "invalid_state")
	check("user said no", b.do(http.MethodGet, "/api/auth/github/callback?error=access_denied", nil), "github_denied")

	// A callback whose state is not the one this browser started with.
	b2 := e.browser()
	b2.do(http.MethodGet, "/api/auth/github/start", nil)
	check("wrong state", b2.do(http.MethodGet, "/api/auth/github/callback?code=x&state=forged", nil), "invalid_state")

	// A code GitHub does not know.
	b3 := e.browser()
	start := b3.do(http.MethodGet, "/api/auth/github/start", nil)
	loc, _ := url.Parse(start.Header.Get("Location"))
	check("unknown code", b3.do(http.MethodGet, "/api/auth/github/callback?code=nope&state="+url.QueryEscape(loc.Query().Get("state")), nil), "github_rejected")

	// A disabled account.
	first := e.browser()
	first.signIn(octocat(), "/")
	e.exec(`UPDATE users SET disabled_at = now()`)
	check("disabled", e.browser().signIn(octocat(), "/"), "account_disabled")
}

func TestCredentialsAndHowTheyAreRead(t *testing.T) {
	e := newAuthEnv(t, httpsOrigin, true)
	b := e.browser()

	none := b.do(http.MethodGet, "/api/me", nil)
	if none.StatusCode != http.StatusUnauthorized || errCode(none) != "unauthorized" {
		t.Errorf("anonymous: %d %s", none.StatusCode, none.body)
	}

	// A stale cookie is answered and cleared, so it stops being sent.
	b.cookies["__Host-fv_session"] = "fvs_" + strings.Repeat("a", 43)
	stale := b.do(http.MethodGet, "/api/me", nil)
	if stale.StatusCode != http.StatusUnauthorized {
		t.Errorf("stale cookie: %d", stale.StatusCode)
	}
	if _, kept := b.cookies["__Host-fv_session"]; kept {
		t.Error("a rejected session cookie should be cleared")
	}

	b.signIn(octocat(), "/")
	token := b.cookies["__Host-fv_session"]
	bearer := map[string]string{"Authorization": "Bearer " + token}

	api := e.browser() // no cookies at all, like a desktop client
	r := api.do(http.MethodGet, "/api/me", bearer)
	if r.StatusCode != http.StatusOK || r.json()["login"] != "octocat" {
		t.Errorf("bearer: %d %s", r.StatusCode, r.body)
	}
	if r.setCookie("__Host-fv_session") != nil {
		t.Error("a bearer client must not be handed cookies")
	}
	if got := api.do(http.MethodGet, "/api/me", map[string]string{"Authorization": "bearer " + token}); got.StatusCode != http.StatusOK {
		t.Error("the scheme name is case-insensitive")
	}
	if got := api.do(http.MethodGet, "/api/me", map[string]string{"Authorization": "Basic " + token}); got.StatusCode != http.StatusUnauthorized {
		t.Error("only the Bearer scheme is accepted")
	}

	// A bearer header takes precedence over a valid cookie: a wrong one is not rescued by it.
	mixed := b.do(http.MethodGet, "/api/me", map[string]string{"Authorization": "Bearer fvs_" + strings.Repeat("b", 43)})
	if mixed.StatusCode != http.StatusUnauthorized {
		t.Errorf("bearer with a valid cookie alongside: %d", mixed.StatusCode)
	}
}

func TestCookieRequestsAreHeldToTheOriginCheck(t *testing.T) {
	e := newAuthEnv(t, httpsOrigin, true)
	b := e.browser()
	b.signIn(octocat(), "/")
	token := b.cookies["__Host-fv_session"]

	for name, header := range map[string]map[string]string{
		"no Origin":        nil,
		"another site":     {"Origin": "https://evil.example"},
		"our host, http":   {"Origin": "http://app.fastvibe.dev"},
		"a sibling domain": {"Origin": "https://fastvibe.dev"},
		"a lookalike":      {"Origin": httpsOrigin + ".evil.example"},
		"null (sandboxed)": {"Origin": "null"},
	} {
		r := b.do(http.MethodPost, "/api/auth/logout", header)
		if r.StatusCode != http.StatusForbidden || errCode(r) != "bad_origin" {
			t.Errorf("%s: %d %s", name, r.StatusCode, r.body)
		}
	}
	if b.do(http.MethodGet, "/api/me", nil).StatusCode != http.StatusOK {
		t.Fatal("refused cross-site requests must not have ended the session")
	}

	// Reads never need it; a bearer client has no ambient credential to forge.
	if e.browser().do(http.MethodPost, "/api/auth/logout", map[string]string{"Authorization": "Bearer " + token}).StatusCode != http.StatusNoContent {
		t.Error("bearer logout should not need an Origin")
	}
	if b.do(http.MethodGet, "/api/me", nil).StatusCode != http.StatusUnauthorized {
		t.Error("the session should be gone after that logout")
	}
}

func TestLogoutEndsTheSessionAndClearsTheCookie(t *testing.T) {
	e := newAuthEnv(t, httpsOrigin, true)
	b := e.browser()
	b.signIn(octocat(), "/")
	token := b.cookies["__Host-fv_session"]

	r := b.do(http.MethodPost, "/api/auth/logout", b.sameOrigin())
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("logout: %d %s", r.StatusCode, r.body)
	}
	if c := r.setCookie("__Host-fv_session"); c == nil || c.MaxAge >= 0 || !c.Secure || c.Path != "/" {
		t.Errorf("the clearing cookie must match the original's attributes or a browser keeps the old one: %+v", c)
	}
	// And the token itself is dead, not merely forgotten by this browser.
	if got := e.browser().do(http.MethodGet, "/api/me", map[string]string{"Authorization": "Bearer " + token}); got.StatusCode != http.StatusUnauthorized {
		t.Errorf("a logged-out token still works: %d", got.StatusCode)
	}
}

func TestSessionsList(t *testing.T) {
	e := newAuthEnv(t, httpsOrigin, true)
	laptop, phone := e.browser(), e.browser()
	laptop.signIn(octocat(), "/")
	phone.signIn(octocat(), "/")
	other := e.browser()
	other.signIn(authtest.Account{ID: 2, Login: "someone-else"}, "/")

	list := func(b *browser) []any {
		t.Helper()
		r := b.do(http.MethodGet, "/api/sessions", nil)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("list: %d %s", r.StatusCode, r.body)
		}
		s, _ := r.json()["sessions"].([]any)
		return s
	}

	mine := list(laptop)
	if len(mine) != 2 {
		t.Fatalf("expected my two sessions and not the stranger's, got %d", len(mine))
	}
	currents := 0
	var phoneID string
	for _, s := range mine {
		row := s.(map[string]any)
		if row["current"] == true {
			currents++
		} else {
			phoneID = row["id"].(string)
		}
		if row["kind"] != "web" || row["last_used_at"] == nil || row["expires_at"] == nil {
			t.Errorf("session row = %v", row)
		}
		if _, leaked := row["token_hash"]; leaked {
			t.Error("the token hash must never leave the server")
		}
	}
	if currents != 1 {
		t.Errorf("exactly one session is the caller's own, %d are marked", currents)
	}

	// Revoking needs the Origin check like any cookie-authenticated write.
	if r := laptop.do(http.MethodDelete, "/api/sessions/"+phoneID, nil); r.StatusCode != http.StatusForbidden {
		t.Errorf("revoke without Origin: %d", r.StatusCode)
	}
	if r := laptop.do(http.MethodDelete, "/api/sessions/"+phoneID, laptop.sameOrigin()); r.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", r.StatusCode, r.body)
	}
	if phone.do(http.MethodGet, "/api/me", nil).StatusCode != http.StatusUnauthorized {
		t.Error("the revoked device should be signed out")
	}
	if laptop.do(http.MethodGet, "/api/me", nil).StatusCode != http.StatusOK {
		t.Error("the other session must be untouched")
	}

	// Not found: already gone, not a UUID, and someone else's all look the same.
	strangerID := list(other)[0].(map[string]any)["id"].(string)
	for name, id := range map[string]string{"already revoked": phoneID, "not a uuid": "not-a-uuid", "someone else's": strangerID} {
		if r := laptop.do(http.MethodDelete, "/api/sessions/"+id, laptop.sameOrigin()); r.StatusCode != http.StatusNotFound || errCode(r) != "not_found" {
			t.Errorf("%s: %d %s", name, r.StatusCode, r.body)
		}
	}
	if other.do(http.MethodGet, "/api/me", nil).StatusCode != http.StatusOK {
		t.Error("probing a stranger's session id revoked it")
	}

	// Revoking the session you are using signs this browser out too.
	selfID := list(laptop)[0].(map[string]any)["id"].(string)
	r := laptop.do(http.MethodDelete, "/api/sessions/"+selfID, laptop.sameOrigin())
	if r.StatusCode != http.StatusNoContent || r.setCookie("__Host-fv_session") == nil || r.setCookie("__Host-fv_session").MaxAge >= 0 {
		t.Errorf("revoking the current session: %d, cookie %+v", r.StatusCode, r.setCookie("__Host-fv_session"))
	}
}

func TestSignInRoutesAreRateLimited(t *testing.T) {
	e := newAuthEnv(t, httpsOrigin, true)
	b := e.browser()
	var limited reply
	for i := 0; i < 40; i++ {
		if r := b.do(http.MethodGet, "/api/auth/github/start", nil); r.StatusCode == http.StatusTooManyRequests {
			limited = r
			break
		}
	}
	if limited.Response == nil || errCode(limited) != "rate_limited" {
		t.Fatal("40 sign-in starts from one address were not limited")
	}
	// The limit is on the sign-in flow, not on the API as a whole.
	if got := b.do(http.MethodGet, "/api/healthz", nil); got.StatusCode != http.StatusOK {
		t.Errorf("healthz is caught by the sign-in limiter: %d", got.StatusCode)
	}
}
