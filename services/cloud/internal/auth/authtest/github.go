// Package authtest is a stand-in for GitHub's OAuth and REST endpoints, for tests that
// sign users in. It enforces what the real thing does where the service relies on it: a
// code works once, the PKCE verifier must hash to the challenge the code was issued
// against, and an access token opens only the account its code belonged to.
package authtest

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

type Email struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

type Account struct {
	ID        int64
	Login     string
	Emails    []Email
	EmailsErr bool   // /user/emails answers 500
	Challenge string // the PKCE challenge the code is issued against
}

type GitHub struct {
	*httptest.Server
	mu       sync.Mutex
	accounts map[string]*Account // by code
	used     map[string]bool
	n        int
}

const (
	ClientID     = "client-id"
	ClientSecret = "client-secret"
)

func New(t testing.TB) *GitHub {
	f := &GitHub{accounts: map[string]*Account{}, used: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /login/oauth/access_token", f.token)
	mux.HandleFunc("GET /user", f.user)
	mux.HandleFunc("GET /user/emails", f.emails)
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

// Issue registers an account and returns a fresh one-time code for it.
func (f *GitHub) Issue(a Account) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.n++
	code := "code" + strconv.Itoa(f.n)
	f.accounts[code] = &a
	return code
}

func (f *GitHub) token(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	code := r.PostForm.Get("code")
	f.mu.Lock()
	acct, known := f.accounts[code]
	reused := f.used[code]
	f.used[code] = true
	f.mu.Unlock()

	reply := func(v any) { w.Header().Set("Content-Type", "application/json"); _ = json.NewEncoder(w).Encode(v) }
	bad := func(desc string) {
		reply(map[string]string{"error": "bad_verification_code", "error_description": desc})
	}
	verifier := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
	switch {
	case r.PostForm.Get("client_id") != ClientID || r.PostForm.Get("client_secret") != ClientSecret:
		reply(map[string]string{"error": "incorrect_client_credentials"})
	case !known || reused:
		bad("The code passed is incorrect or expired.")
	case base64.RawURLEncoding.EncodeToString(verifier[:]) != acct.Challenge:
		bad("PKCE verification failed.")
	default:
		reply(map[string]string{"access_token": "at_" + code, "token_type": "bearer"})
	}
}

func (f *GitHub) byToken(r *http.Request) *Account {
	code := strings.TrimPrefix(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "at_")
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.accounts[code]
}

func (f *GitHub) user(w http.ResponseWriter, r *http.Request) {
	acct := f.byToken(r)
	if acct == nil {
		http.Error(w, `{"message":"Bad credentials"}`, http.StatusUnauthorized)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id": acct.ID, "login": acct.Login, "avatar_url": "https://avatars.example/" + acct.Login,
		"created_at": "2015-03-01T10:00:00Z",
		// A profile field anyone may fill with any address; the service must never trust it.
		"email": "public-claim@example.com",
	})
}

func (f *GitHub) emails(w http.ResponseWriter, r *http.Request) {
	acct := f.byToken(r)
	switch {
	case acct == nil:
		http.Error(w, `{"message":"Bad credentials"}`, http.StatusUnauthorized)
	case acct.EmailsErr:
		http.Error(w, `{"message":"boom"}`, http.StatusInternalServerError)
	default:
		_ = json.NewEncoder(w).Encode(acct.Emails)
	}
}
