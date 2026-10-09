COMPOSE := docker compose -f deploy/docker-compose.yml
TEST_DATABASE_URL ?= postgres://fastvibe:fastvibe@127.0.0.1:5433/cloud_test?sslmode=disable

.PHONY: test test-db up down run vet nginx-check sqlc

# Unit tests only; the database tests skip without TEST_DATABASE_URL.
test:
	go test ./...

# Everything, including the schema and billing-invariant tests against a real Postgres.
test-db:
	$(COMPOSE) up -d --wait postgres
	TEST_DATABASE_URL='$(TEST_DATABASE_URL)' go test -count=1 ./...

vet:
	go vet ./...

up:
	$(COMPOSE) up --build -d --wait

down:
	$(COMPOSE) down

# Syntax-check the snippets for the server's nginx: wrap them in a minimal http {}
# and run `nginx -t` in the same nginx version.
nginx-check:
	docker run --rm -v "$(CURDIR)/deploy/nginx:/etc/nginx/fastvibe:ro" nginx:1.30-alpine sh -c '\
		printf "events {}\nhttp {\n include /etc/nginx/fastvibe/upstreams.conf;\n server { listen 8000; include /etc/nginx/fastvibe/locations.conf; }\n}\n" > /tmp/test.conf && \
		nginx -t -c /tmp/test.conf'

# Run the service on the host against the compose database. Settings come from
# .env.local if it exists (git-ignored; put the GitHub OAuth App credentials and
# FASTVIBE_PUBLIC_ORIGIN there), and the environment overrides the defaults below.
# The browser must use the same origin as FASTVIBE_PUBLIC_ORIGIN, host name included.
run:
	$(COMPOSE) up -d --wait postgres
	set -a; [ -f .env.local ] && . ./.env.local; set +a; \
	FASTVIBE_ENV=$${FASTVIBE_ENV:-development} \
	FASTVIBE_PUBLIC_ORIGIN=$${FASTVIBE_PUBLIC_ORIGIN:-http://localhost:9088} \
	FASTVIBE_HTTP__LISTEN=$${FASTVIBE_HTTP__LISTEN:-127.0.0.1:9089} \
	FASTVIBE_DATABASE__URL=$${FASTVIBE_DATABASE__URL:-postgres://fastvibe:fastvibe@127.0.0.1:5433/cloud?sslmode=disable} \
	go run ./cmd/cloud

# Regenerate internal/store/gen from migrations/ and internal/store/queries/.
sqlc:
	sqlc generate
