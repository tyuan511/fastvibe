-- name: UpsertGitHubUser :one
-- Sign-in creates the account on first sight and refreshes what GitHub owns on
-- every later one. The numeric id is the identity; login and avatar follow it.
INSERT INTO users (github_id, github_login, avatar_url, github_created_at)
VALUES (@github_id, @github_login, @avatar_url, @github_created_at)
ON CONFLICT (github_id) DO UPDATE SET
    github_login      = EXCLUDED.github_login,
    avatar_url        = EXCLUDED.avatar_url,
    github_created_at = COALESCE(EXCLUDED.github_created_at, users.github_created_at)
RETURNING *, (xmax = 0) AS inserted;

-- name: GetUser :one
SELECT * FROM users WHERE id = @id;

-- name: SetUserEmail :exec
UPDATE users SET email = @email, email_verified_at = now() WHERE id = @id;

-- name: ClearUserEmail :exec
UPDATE users SET email = NULL, email_verified_at = NULL WHERE id = @id AND email IS NOT NULL;

-- name: PromoteUserToAdmin :exec
UPDATE users SET role = 'admin' WHERE id = @id AND role <> 'admin';

-- name: EnsureBalance :exec
INSERT INTO balances (user_id) VALUES (@user_id) ON CONFLICT (user_id) DO NOTHING;
