package httpapi

import (
	"errors"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/limiter"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/tyuan511/fastvibe/services/cloud/internal/auth"
	"github.com/tyuan511/fastvibe/services/cloud/internal/config"
)

const (
	principalLocal = "principal"
	tokenLocal     = "token"
	sourceLocal    = "token_source"

	sourceCookie = "cookie"
	sourceBearer = "bearer"

	// oauthCookieMaxAge matches the state's lifetime inside the auth service.
	oauthCookieMaxAge = 10 * 60
)

// authAPI is the HTTP face of the auth service: the GitHub redirect dance, the session
// cookie, and the routes that read or end the caller's own sessions.
type authAPI struct {
	svc *auth.Service
	cfg *config.Config
	log *zap.Logger

	sessionCookie string
	oauthCookie   string
	secure        bool
}

func registerAuth(api fiber.Router, deps Deps) {
	a := &authAPI{svc: deps.Auth, cfg: deps.Config, log: deps.Log}
	// Over https the cookies carry the __Host- prefix, which makes a browser refuse them
	// unless they are Secure, host-only and Path=/: a sibling subdomain (fastvibe.dev
	// runs another service) cannot plant or overwrite them. Plain-http development
	// cannot use the prefix.
	if strings.HasPrefix(a.cfg.PublicOrigin, "https://") {
		a.sessionCookie, a.oauthCookie, a.secure = "__Host-fv_session", "__Host-fv_oauth", true
	} else {
		a.sessionCookie, a.oauthCookie = "fv_session", "fv_oauth"
	}

	// Sign-in is a handful of requests per person per day; this stops one address from
	// using it to hammer GitHub or the database.
	flow := limiter.New(limiter.Config{
		Max:          30,
		Expiration:   time.Minute,
		KeyGenerator: ClientIP,
		LimitReached: func(fiber.Ctx) error {
			return NewError(fiber.StatusTooManyRequests, "rate_limited", "too many sign-in attempts, try again in a minute")
		},
	})
	gh := api.Group("/auth/github", flow)
	gh.Get("/start", a.start)
	gh.Get("/callback", a.callback)

	api.Post("/auth/logout", a.require, a.logout)
	api.Get("/me", a.require, a.me)
	api.Get("/sessions", a.require, a.listSessions)
	api.Delete("/sessions/:id", a.require, a.revokeSession)
}

// PrincipalFrom returns the caller a.require authenticated.
func PrincipalFrom(c fiber.Ctx) (auth.Principal, bool) {
	p, ok := c.Locals(principalLocal).(auth.Principal)
	return p, ok
}

// ---- sign-in routes -------------------------------------------------------------------

func (a *authAPI) start(c fiber.Ctx) error {
	if !a.svc.GitHubConfigured() {
		return NewError(fiber.StatusServiceUnavailable, "github_not_configured", "GitHub sign-in is not configured on this server")
	}
	authorizeURL, state, err := a.svc.BeginLogin(c.Query("return_to"))
	if err != nil {
		return err
	}
	// Lax, not Strict: the cookie must come back on the top-level redirect from github.com.
	c.Cookie(&fiber.Cookie{
		Name: a.oauthCookie, Value: state, Path: "/", MaxAge: oauthCookieMaxAge,
		HTTPOnly: true, Secure: a.secure, SameSite: fiber.CookieSameSiteLaxMode,
	})
	noStore(c)
	return c.Redirect().Status(fiber.StatusFound).To(authorizeURL)
}

func (a *authAPI) callback(c fiber.Ctx) error {
	// This URL carries a one-time code; keep it out of any Referer the next page sends.
	c.Set("Referrer-Policy", "no-referrer")
	noStore(c)

	stateCookie := c.Cookies(a.oauthCookie)
	a.clearCookie(c, a.oauthCookie)

	if e := c.Query("error"); e != "" {
		return a.signInFailed(c, "github_denied")
	}
	res, err := a.svc.CompleteLogin(c.Context(), auth.CompleteInput{
		Code:        c.Query("code"),
		State:       c.Query("state"),
		StateCookie: stateCookie,
		Client:      clientOf(c),
	})
	switch {
	case err == nil:
	case errors.Is(err, auth.ErrInvalidState):
		return a.signInFailed(c, "invalid_state")
	case errors.Is(err, auth.ErrDisabled):
		return a.signInFailed(c, "account_disabled")
	case errors.Is(err, auth.ErrCodeRejected):
		return a.signInFailed(c, "github_rejected")
	case errors.Is(err, auth.ErrGitHubUnavailable):
		a.log.Warn("github unavailable during sign-in", zap.Error(err), zap.String("request_id", RequestID(c)))
		return a.signInFailed(c, "github_unavailable")
	default:
		a.log.Error("sign-in failed", zap.Error(err), zap.String("request_id", RequestID(c)))
		return a.signInFailed(c, "internal_error")
	}

	a.setSessionCookie(c, res.Token)
	return c.Redirect().Status(fiber.StatusFound).To(res.ReturnTo)
}

// signInFailed sends the browser to the login page with a code the page words for people.
func (a *authAPI) signInFailed(c fiber.Ctx, code string) error {
	return c.Redirect().Status(fiber.StatusFound).To("/login?error=" + url.QueryEscape(code))
}

// ---- authenticated routes -------------------------------------------------------------

// require authenticates the request. A bearer header wins over a cookie; only the cookie
// form is open to cross-site forgery, so only it is held to the Origin check.
func (a *authAPI) require(c fiber.Ctx) error {
	token, source := a.tokenOf(c)
	if token == "" {
		return errUnauthorized
	}
	if source == sourceCookie && !safeMethod(c.Method()) && c.Get(fiber.HeaderOrigin) != a.cfg.PublicOrigin {
		return NewError(fiber.StatusForbidden, "bad_origin", "request origin not allowed")
	}

	p, err := a.svc.Authenticate(c.Context(), token)
	if errors.Is(err, auth.ErrUnauthenticated) {
		if source == sourceCookie {
			a.clearCookie(c, a.sessionCookie) // a dead cookie is just noise on every later request
		}
		return errUnauthorized
	}
	if err != nil {
		return err
	}
	if source == sourceCookie {
		// The server slides the session forward on use; slide the cookie with it, or the
		// browser would drop it 30 days after sign-in however often it was used.
		a.setSessionCookie(c, token)
	}
	c.Locals(principalLocal, p)
	c.Locals(tokenLocal, token)
	c.Locals(sourceLocal, source)
	return c.Next()
}

var errUnauthorized = NewError(fiber.StatusUnauthorized, "unauthorized", "sign in required")

func (a *authAPI) tokenOf(c fiber.Ctx) (token, source string) {
	if h := c.Get(fiber.HeaderAuthorization); h != "" {
		scheme, value, _ := strings.Cut(h, " ")
		if strings.EqualFold(scheme, "Bearer") {
			return strings.TrimSpace(value), sourceBearer
		}
		return "", ""
	}
	if v := c.Cookies(a.sessionCookie); v != "" {
		return v, sourceCookie
	}
	return "", ""
}

func (a *authAPI) logout(c fiber.Ctx) error {
	if err := a.svc.Logout(c.Context(), c.Locals(tokenLocal).(string), clientOf(c)); err != nil {
		return err
	}
	a.clearCookie(c, a.sessionCookie)
	return c.SendStatus(fiber.StatusNoContent)
}

func (a *authAPI) me(c fiber.Ctx) error {
	p, _ := PrincipalFrom(c)
	u, err := a.svc.User(c.Context(), p.UserID)
	if err != nil {
		return err
	}
	return noStore(c).JSON(fiber.Map{
		"id":         u.ID,
		"login":      u.GithubLogin,
		"avatar_url": u.AvatarUrl,
		"email":      u.Email,
		"role":       u.Role,
		"created_at": u.CreatedAt,
	})
}

func (a *authAPI) listSessions(c fiber.Ctx) error {
	p, _ := PrincipalFrom(c)
	rows, err := a.svc.ListSessions(c.Context(), p.UserID)
	if err != nil {
		return err
	}
	out := make([]fiber.Map, 0, len(rows))
	for _, r := range rows {
		out = append(out, fiber.Map{
			"id":           r.ID,
			"kind":         r.Kind,
			"device_name":  r.DeviceName,
			"platform":     r.Platform,
			"user_agent":   r.UserAgent,
			"created_at":   r.CreatedAt,
			"last_used_at": r.LastUsedAt,
			"expires_at":   r.ExpiresAt,
			"current":      r.ID == p.SessionID,
		})
	}
	return noStore(c).JSON(fiber.Map{"sessions": out})
}

func (a *authAPI) revokeSession(c fiber.Ctx) error {
	p, _ := PrincipalFrom(c)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return errSessionNotFound
	}
	switch err := a.svc.RevokeSession(c.Context(), p.UserID, id, clientOf(c)); {
	case errors.Is(err, auth.ErrNotFound):
		return errSessionNotFound
	case err != nil:
		return err
	}
	if id == p.SessionID {
		a.clearCookie(c, a.sessionCookie)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

var errSessionNotFound = NewError(fiber.StatusNotFound, "not_found", "no such session")

// ---- helpers --------------------------------------------------------------------------

func (a *authAPI) setSessionCookie(c fiber.Ctx, token string) {
	c.Cookie(&fiber.Cookie{
		Name: a.sessionCookie, Value: token, Path: "/", MaxAge: int(a.cfg.Session.WebTTL.Seconds()),
		HTTPOnly: true, Secure: a.secure, SameSite: fiber.CookieSameSiteLaxMode,
	})
}

// clearCookie expires a cookie with the same attributes it was set with; a browser
// matches on name, domain and path, and a __Host- cookie must also stay Secure.
func (a *authAPI) clearCookie(c fiber.Ctx, name string) {
	c.Cookie(&fiber.Cookie{
		Name: name, Value: "", Path: "/", MaxAge: -1, Expires: time.Unix(0, 0),
		HTTPOnly: true, Secure: a.secure, SameSite: fiber.CookieSameSiteLaxMode,
	})
}

func safeMethod(m string) bool {
	return m == fiber.MethodGet || m == fiber.MethodHead || m == fiber.MethodOptions
}

func clientOf(c fiber.Ctx) auth.Client {
	ip, _ := netip.ParseAddr(ClientIP(c)) // zero on failure, which auth.Client treats as unknown
	return auth.Client{IP: ip, UserAgent: c.Get(fiber.HeaderUserAgent)}
}
