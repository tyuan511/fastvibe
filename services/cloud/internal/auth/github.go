package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// GitHub talks to GitHub's OAuth and REST endpoints. The base URLs are fields so tests
// can point it at a local server.
type GitHub struct {
	ClientID     string
	ClientSecret string
	OAuthBase    string // https://github.com
	APIBase      string // https://api.github.com
	HTTP         *http.Client
}

// NewGitHub returns a client for the real GitHub.
func NewGitHub(clientID, clientSecret string) *GitHub {
	return &GitHub{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		OAuthBase:    "https://github.com",
		APIBase:      "https://api.github.com",
		HTTP:         &http.Client{Timeout: 10 * time.Second},
	}
}

// Scopes are the least that gives us a verified email: the profile and the email list.
const scopes = "read:user user:email"

// AuthorizeURL is where the browser is sent to approve the sign-in.
func (g *GitHub) AuthorizeURL(redirectURI, state, challenge string) string {
	q := url.Values{
		"client_id":             {g.ClientID},
		"redirect_uri":          {redirectURI},
		"scope":                 {scopes},
		"state":                 {state},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"allow_signup":          {"true"},
	}
	return g.OAuthBase + "/login/oauth/authorize?" + q.Encode()
}

// Exchange trades the one-time code for an access token.
func (g *GitHub) Exchange(ctx context.Context, code, verifier, redirectURI string) (string, error) {
	form := url.Values{
		"client_id":     {g.ClientID},
		"client_secret": {g.ClientSecret},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"code_verifier": {verifier},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.OAuthBase+"/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	var out struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	if err := g.do(req, &out); err != nil {
		return "", err
	}
	// GitHub answers 200 with an error body for a bad or reused code.
	if out.Error != "" {
		return "", fmt.Errorf("%w: %s: %s", ErrCodeRejected, out.Error, out.Description)
	}
	if out.AccessToken == "" {
		return "", errors.New("github returned no access token")
	}
	return out.AccessToken, nil
}

// GitHubUser is the part of the profile we keep.
type GitHubUser struct {
	ID        int64     `json:"id"`
	Login     string    `json:"login"`
	AvatarURL string    `json:"avatar_url"`
	CreatedAt time.Time `json:"created_at"`
}

func (g *GitHub) User(ctx context.Context, accessToken string) (GitHubUser, error) {
	var u GitHubUser
	if err := g.get(ctx, accessToken, "/user", &u); err != nil {
		return u, err
	}
	if u.ID == 0 || u.Login == "" {
		return u, errors.New("github returned an empty profile")
	}
	return u, nil
}

type gitHubEmail struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

// VerifiedPrimaryEmail is the user's primary email if GitHub has verified it, else "".
// The email on /user is a public profile field anyone may fill with any address, so it
// is never used as an identity.
func (g *GitHub) VerifiedPrimaryEmail(ctx context.Context, accessToken string) (string, error) {
	var emails []gitHubEmail
	if err := g.get(ctx, accessToken, "/user/emails", &emails); err != nil {
		return "", err
	}
	for _, e := range emails {
		if e.Primary && e.Verified && e.Email != "" {
			return strings.ToLower(e.Email), nil
		}
	}
	return "", nil
}

func (g *GitHub) get(ctx context.Context, accessToken, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.APIBase+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	return g.do(req, out)
}

func (g *GitHub) do(req *http.Request, out any) error {
	resp, err := g.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrGitHubUnavailable, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrGitHubUnavailable, err)
	}
	if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
		return fmt.Errorf("%w: status %d", ErrGitHubUnavailable, resp.StatusCode)
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%w: status %d", ErrCodeRejected, resp.StatusCode)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("%w: unreadable response: %v", ErrGitHubUnavailable, err)
	}
	return nil
}
