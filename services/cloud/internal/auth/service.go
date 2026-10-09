package auth

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/tyuan511/fastvibe/services/cloud/internal/config"
	"github.com/tyuan511/fastvibe/services/cloud/internal/store/gen"
)

// CallbackPath is registered with the GitHub OAuth App.
const CallbackPath = "/api/auth/github/callback"

const (
	// stateTTL is how long a sign-in may take between leaving for GitHub and coming back.
	stateTTL = 10 * time.Minute
	// touchEvery is how often a session that is in use gets its expiry pushed out.
	touchEvery = 10 * time.Minute
	// deviceTTL is for desktop and phone sessions, which are used less often than a tab.
	deviceTTL = 90 * 24 * time.Hour
)

var (
	// ErrUnauthenticated means no usable session: absent, malformed, expired,
	// revoked or belonging to a disabled account. Callers cannot and need not tell which.
	ErrUnauthenticated = errors.New("not signed in")
	// ErrInvalidState means the sign-in did not start here, or took too long.
	ErrInvalidState = errors.New("invalid or expired sign-in state")
	// ErrDisabled means the account exists and has been turned off.
	ErrDisabled = errors.New("account disabled")
	// ErrCodeRejected means GitHub refused the code (reused, expired, or not ours).
	ErrCodeRejected = errors.New("github rejected the sign-in")
	// ErrGitHubUnavailable means GitHub could not be reached or answered with an error.
	ErrGitHubUnavailable = errors.New("github unavailable")
	// ErrNotFound means the session does not exist or is not the caller's.
	ErrNotFound = errors.New("session not found")
)

// Client describes who is on the other end, for audit rows and session records.
type Client struct {
	IP        netip.Addr // zero when unknown
	UserAgent string
}

func (c Client) ip() *netip.Addr {
	if !c.IP.IsValid() {
		return nil
	}
	ip := c.IP
	return &ip
}

func (c Client) userAgent() *string {
	if c.UserAgent == "" {
		return nil
	}
	ua := c.UserAgent
	if len(ua) > 512 {
		ua = ua[:512]
	}
	return &ua
}

// Principal is an authenticated caller.
type Principal struct {
	SessionID uuid.UUID
	UserID    uuid.UUID
	Role      string
	Login     string
	Kind      string
}

func (p Principal) IsAdmin() bool { return p.Role == "admin" }

type Service struct {
	pool  *pgxpool.Pool
	q     *gen.Queries
	cfg   *config.Config
	gh    *GitHub
	log   *zap.Logger
	now   func() time.Time
	cache *tokenCache
}

func New(pool *pgxpool.Pool, cfg *config.Config, gh *GitHub, log *zap.Logger) *Service {
	return &Service{
		pool:  pool,
		q:     gen.New(pool),
		cfg:   cfg,
		gh:    gh,
		log:   log,
		now:   time.Now,
		cache: newTokenCache(cfg.Session.CacheTTL),
	}
}

// GitHubConfigured reports whether sign-in can work at all.
func (s *Service) GitHubConfigured() bool { return s.cfg.GitHub.Configured() }

// ---- sign-in --------------------------------------------------------------------------

// loginState is what the browser carries from /start to /callback, in a cookie. It holds
// the CSRF state, the PKCE verifier and where to land afterwards. The cookie is HttpOnly
// and, over https, __Host- prefixed, so neither page script nor a sibling subdomain can
// read or plant it; that is what makes an unsigned value safe here.
type loginState struct {
	State    string `json:"s"`
	Verifier string `json:"v"`
	ReturnTo string `json:"r"`
	Expires  int64  `json:"e"`
}

// BeginLogin returns the GitHub URL to send the browser to and the value of the state
// cookie to set alongside the redirect.
func (s *Service) BeginLogin(returnTo string) (authorizeURL, stateCookie string, err error) {
	state, err := randomString(24)
	if err != nil {
		return "", "", err
	}
	verifier, err := randomString(32)
	if err != nil {
		return "", "", err
	}
	raw, err := json.Marshal(loginState{
		State:    state,
		Verifier: verifier,
		ReturnTo: SafeReturnTo(returnTo),
		Expires:  s.now().Add(stateTTL).Unix(),
	})
	if err != nil {
		return "", "", err
	}
	return s.gh.AuthorizeURL(s.cfg.PublicOrigin+CallbackPath, state, pkceChallenge(verifier)),
		base64.RawURLEncoding.EncodeToString(raw), nil
}

type CompleteInput struct {
	Code        string
	State       string // from the query string
	StateCookie string // from the cookie BeginLogin produced
	Client      Client
}

type LoginResult struct {
	Token     string
	ReturnTo  string
	UserID    uuid.UUID
	ExpiresAt time.Time
}

// CompleteLogin finishes a sign-in: it checks the state, trades the code with GitHub,
// finds or creates the account, and opens a session. GitHub is called before the
// transaction opens, so a slow GitHub never holds a database connection.
func (s *Service) CompleteLogin(ctx context.Context, in CompleteInput) (LoginResult, error) {
	st, err := s.decodeState(in.StateCookie)
	if err != nil || in.Code == "" || subtle.ConstantTimeCompare([]byte(st.State), []byte(in.State)) != 1 {
		return LoginResult{}, ErrInvalidState
	}

	redirectURI := s.cfg.PublicOrigin + CallbackPath
	accessToken, err := s.gh.Exchange(ctx, in.Code, st.Verifier, redirectURI)
	if err != nil {
		return LoginResult{}, err
	}
	ghUser, err := s.gh.User(ctx, accessToken)
	if err != nil {
		return LoginResult{}, err
	}
	// The email is a convenience. If GitHub cannot give it now, sign in anyway and
	// leave whatever we already hold untouched.
	email, emailErr := s.gh.VerifiedPrimaryEmail(ctx, accessToken)
	if emailErr != nil {
		s.log.Warn("could not read github emails", zap.Error(emailErr), zap.Int64("github_id", ghUser.ID))
	}

	token, err := newToken()
	if err != nil {
		return LoginResult{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return LoginResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)

	var created *time.Time
	if !ghUser.CreatedAt.IsZero() {
		created = &ghUser.CreatedAt
	}
	var avatar *string
	if ghUser.AvatarURL != "" {
		avatar = &ghUser.AvatarURL
	}
	user, err := q.UpsertGitHubUser(ctx, gen.UpsertGitHubUserParams{
		GithubID:        ghUser.ID,
		GithubLogin:     ghUser.Login,
		AvatarUrl:       avatar,
		GithubCreatedAt: created,
	})
	if err != nil {
		return LoginResult{}, fmt.Errorf("save user: %w", err)
	}

	if user.DisabledAt != nil {
		s.audit(ctx, q, &user.ID, "login_refused", "", in.Client, map[string]any{"reason": "disabled"})
		if err := tx.Commit(ctx); err != nil {
			return LoginResult{}, err
		}
		return LoginResult{}, ErrDisabled
	}

	if emailErr == nil {
		if err := s.syncEmail(ctx, tx, q, user.ID, user.Email, email, in.Client); err != nil {
			return LoginResult{}, err
		}
	}

	if slices.Contains(s.cfg.Admin.GitHubIDs, user.GithubID) && user.Role != "admin" {
		if err := q.PromoteUserToAdmin(ctx, user.ID); err != nil {
			return LoginResult{}, fmt.Errorf("promote admin: %w", err)
		}
		s.audit(ctx, q, &user.ID, "admin_granted", "", in.Client, nil)
	}

	if err := q.EnsureBalance(ctx, user.ID); err != nil {
		return LoginResult{}, fmt.Errorf("create balance: %w", err)
	}

	expires := s.now().Add(s.ttlFor("web"))
	sess, err := q.CreateSession(ctx, gen.CreateSessionParams{
		UserID:    user.ID,
		TokenHash: hashToken(token),
		Kind:      "web",
		UserAgent: in.Client.userAgent(),
		Ip:        in.Client.ip(),
		ExpiresAt: expires,
	})
	if err != nil {
		return LoginResult{}, fmt.Errorf("create session: %w", err)
	}
	s.audit(ctx, q, &user.ID, "login", sess.ID.String(), in.Client, map[string]any{"new_user": user.Inserted})

	if err := tx.Commit(ctx); err != nil {
		return LoginResult{}, err
	}
	return LoginResult{Token: token, ReturnTo: SafeReturnTo(st.ReturnTo), UserID: user.ID, ExpiresAt: expires}, nil
}

// syncEmail makes the stored email match GitHub's verified primary one. An email that
// already belongs to another account is not written (the login still succeeds): the
// savepoint keeps that unique violation from aborting the whole sign-in transaction.
func (s *Service) syncEmail(ctx context.Context, tx pgx.Tx, q *gen.Queries, userID uuid.UUID, have *string, want string, client Client) error {
	if want == "" {
		return q.ClearUserEmail(ctx, userID)
	}
	if have != nil && *have == want {
		return nil
	}
	sp, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	err = q.WithTx(sp).SetUserEmail(ctx, gen.SetUserEmailParams{ID: userID, Email: &want})
	if err == nil {
		return sp.Commit(ctx)
	}
	_ = sp.Rollback(ctx)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		s.audit(ctx, q, &userID, "email_conflict", "", client, nil)
		return nil
	}
	return fmt.Errorf("save email: %w", err)
}

func (s *Service) decodeState(cookie string) (loginState, error) {
	var st loginState
	raw, err := base64.RawURLEncoding.DecodeString(cookie)
	if err != nil || json.Unmarshal(raw, &st) != nil {
		return st, ErrInvalidState
	}
	if st.State == "" || st.Verifier == "" || s.now().Unix() > st.Expires {
		return st, ErrInvalidState
	}
	return st, nil
}

// ---- sessions -------------------------------------------------------------------------

func (s *Service) ttlFor(kind string) time.Duration {
	if kind == "web" {
		return s.cfg.Session.WebTTL
	}
	return deviceTTL
}

// Authenticate resolves a token to its caller. A token seen within the cache window is
// answered from memory; otherwise one indexed query settles it, and a session in use has
// its expiry pushed out so it lapses only after a stretch of not being used.
func (s *Service) Authenticate(ctx context.Context, token string) (Principal, error) {
	if !wellFormed(token) {
		return Principal{}, ErrUnauthenticated
	}
	hash := hashToken(token)
	if p, ok := s.cache.get(hash, s.now()); ok {
		return p, nil
	}

	row, err := s.q.GetLiveSession(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return Principal{}, ErrUnauthenticated
	}
	if err != nil {
		return Principal{}, fmt.Errorf("look up session: %w", err)
	}
	if s.now().Sub(row.LastUsedAt) > touchEvery {
		err := s.q.TouchSession(ctx, gen.TouchSessionParams{ID: row.ID, ExpiresAt: s.now().Add(s.ttlFor(row.Kind))})
		if err != nil {
			s.log.Warn("could not extend session", zap.Error(err), zap.String("session_id", row.ID.String()))
		}
	}
	p := Principal{SessionID: row.ID, UserID: row.UserID, Role: row.Role, Login: row.GithubLogin, Kind: row.Kind}
	s.cache.put(hash, p, s.now())
	return p, nil
}

// Logout ends the session a token belongs to. It is not an error to log out of a
// session that is already gone.
func (s *Service) Logout(ctx context.Context, token string, client Client) error {
	hash := hashToken(token)
	s.cache.delete(hash)
	row, err := s.q.RevokeSessionByTokenHash(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	s.audit(ctx, s.q, &row.UserID, "logout", row.ID.String(), client, nil)
	return nil
}

// RevokeSession ends one of the caller's own sessions. Another user's session id is
// indistinguishable from one that does not exist.
func (s *Service) RevokeSession(ctx context.Context, userID, sessionID uuid.UUID, client Client) error {
	hash, err := s.q.RevokeUserSession(ctx, gen.RevokeUserSessionParams{ID: sessionID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	s.cache.delete(hash)
	s.audit(ctx, s.q, &userID, "session_revoked", sessionID.String(), client, nil)
	return nil
}

func (s *Service) ListSessions(ctx context.Context, userID uuid.UUID) ([]gen.ListLiveSessionsRow, error) {
	return s.q.ListLiveSessions(ctx, userID)
}

func (s *Service) User(ctx context.Context, id uuid.UUID) (gen.User, error) {
	return s.q.GetUser(ctx, id)
}

// Purge deletes sessions that died more than 90 days ago.
func (s *Service) Purge(ctx context.Context) (int64, error) {
	return s.q.PurgeDeadSessions(ctx)
}

// PurgeLoop runs Purge every interval until ctx ends.
func (s *Service) PurgeLoop(ctx context.Context, interval time.Duration) {
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			n, err := s.Purge(ctx)
			if err != nil {
				s.log.Error("purge sessions", zap.Error(err))
				continue
			}
			if n > 0 {
				s.log.Info("purged dead sessions", zap.Int64("count", n))
			}
		}
	}
}

// Audit records an action by or about a user.
func (s *Service) Audit(ctx context.Context, userID *uuid.UUID, action, target string, client Client, meta map[string]any) {
	s.audit(ctx, s.q, userID, action, target, client, meta)
}

// audit never fails the request it describes: a lost audit row is logged, not surfaced.
func (s *Service) audit(ctx context.Context, q *gen.Queries, userID *uuid.UUID, action, target string, client Client, meta map[string]any) {
	if meta == nil {
		meta = map[string]any{}
	}
	raw, err := json.Marshal(meta)
	if err != nil {
		raw = []byte("{}")
	}
	var tgt *string
	if target != "" {
		tgt = &target
	}
	err = q.InsertAudit(ctx, gen.InsertAuditParams{
		UserID: userID, Action: action, Target: tgt, Ip: client.ip(), UserAgent: client.userAgent(), Meta: raw,
	})
	if err != nil {
		s.log.Error("write audit row", zap.Error(err), zap.String("action", action))
	}
}

// ---- token cache ----------------------------------------------------------------------

// tokenCache remembers verified tokens for a short while so a busy /llm client does not
// cost a query per request. Revoking on this instance evicts at once; on another instance
// the revocation lands within ttl.
type tokenCache struct {
	ttl time.Duration
	mu  sync.Mutex
	m   map[[32]byte]cacheEntry
}

type cacheEntry struct {
	p       Principal
	expires time.Time
}

const cacheLimit = 50_000

func newTokenCache(ttl time.Duration) *tokenCache {
	return &tokenCache{ttl: ttl, m: map[[32]byte]cacheEntry{}}
}

func (c *tokenCache) get(hash []byte, now time.Time) (Principal, bool) {
	if c.ttl <= 0 {
		return Principal{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[[32]byte(hash)]
	if !ok || now.After(e.expires) {
		delete(c.m, [32]byte(hash))
		return Principal{}, false
	}
	return e.p, true
}

func (c *tokenCache) put(hash []byte, p Principal, now time.Time) {
	if c.ttl <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= cacheLimit {
		for k, e := range c.m {
			if now.After(e.expires) {
				delete(c.m, k)
			}
		}
		if len(c.m) >= cacheLimit {
			clear(c.m)
		}
	}
	c.m[[32]byte(hash)] = cacheEntry{p: p, expires: now.Add(c.ttl)}
}

func (c *tokenCache) delete(hash []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.m, [32]byte(hash))
}
