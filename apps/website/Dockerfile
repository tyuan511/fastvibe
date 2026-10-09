# The website is one workspace package, so the build context is the repository root:
#
#   docker build -f apps/website/Dockerfile .
#
# A plain workspace install would also build the root package's native dependencies
# (node-pty, electron), which the site never imports and which fail in this image.
# `pnpm deploy` installs the website as its own project from the repo lockfile, and
# the build runs with pnpm's own node_modules linker so it never re-verifies the
# install (pnpm 11 aborts when a dependency's build script is merely not approved).

FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/website/package.json apps/website/package.json
RUN pnpm --filter @fastvibe/website deploy --legacy /out/website
COPY apps/website apps/website
RUN cp /src/apps/website/package.json /out/pkg.json && \
    cp -a /src/apps/website/app /src/apps/website/components /src/apps/website/i18n \
      /src/apps/website/lib /src/apps/website/messages /src/apps/website/public /out/website/ && \
    cp /src/apps/website/middleware.ts /src/apps/website/next.config.ts /src/apps/website/tsconfig.json \
      /src/apps/website/eslint.config.mjs /out/website/ && \
    cp /out/pkg.json /out/website/package.json && \
    cd /out/website && /out/website/node_modules/.bin/next build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/website/.next/standalone ./
COPY --from=build /out/website/.next/static ./.next/static
COPY --from=build /out/website/public ./public
EXPOSE 9088
CMD ["node", "server.js"]
