# Dockerfile for Chorus

# Development stage
FROM node:22-alpine AS development

# Install OpenSSL for Prisma and enable corepack for pnpm
RUN apk add --no-cache openssl && corepack enable

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY . .

# Generate Prisma client
RUN pnpm db:generate

# Expose port
EXPOSE 8637

# Development command (overridden in docker-compose)
CMD ["pnpm", "dev"]

# Production build stage
FROM node:22-alpine AS builder

# Install OpenSSL for Prisma and enable corepack for pnpm
RUN apk add --no-cache openssl && corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY . .
RUN node scripts/prisma-migration-version.mjs > /prisma-migration-version
RUN pnpm build

# Dereference pnpm symlinks for PGlite packages (needed in production stage)
RUN mkdir -p /pglite-deps/node_modules/@electric-sql \
 && cp -rL node_modules/@electric-sql/pglite /pglite-deps/node_modules/@electric-sql/pglite \
 && cp -rL node_modules/@electric-sql/pglite-socket /pglite-deps/node_modules/@electric-sql/pglite-socket

# Production stage (standalone)
FROM node:22-alpine AS production

RUN apk add --no-cache openssl && corepack enable

WORKDIR /app

ENV NODE_ENV=production

# Copy standalone server (includes server.js + minimal node_modules)
COPY --from=builder /app/.next/standalone ./

# Copy static assets and public files (not included in standalone)
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy Prisma schema + config for migrations
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /prisma-migration-version /tmp/prisma-migration-version

# Install the exact stable CLI resolved and validated with the client and adapter
# in the builder. Unversioned installs follow mutable npm dist-tags, which can
# select a prerelease/new major; stable Prisma 7.x still supports migrate deploy.
#
# Prisma 7.x pins mysql2 3.15.3 and deepmerge-ts 7.1.5 exactly, both with HIGH
# advisories (prisma/prisma#30295). `pnpm add -g` cannot override them, so the
# CLI is installed with npm into its own prefix whose package.json carries npm
# overrides, matching the versions the root package.json pins for the app.
# /app/prisma.config.ts imports `prisma/config`, so the package is linked into
# /app/node_modules for the config loader to resolve it.
# Remove the overrides once a Prisma release ships patched versions.
ENV PATH="/opt/prisma/node_modules/.bin:$PATH"
RUN PRISMA_MIGRATION_VERSION="$(cat /tmp/prisma-migration-version)" \
 && test -n "$PRISMA_MIGRATION_VERSION" \
 && mkdir -p /opt/prisma && cd /opt/prisma \
 && printf '%s\n' '{"private":true,"overrides":{"mysql2":"3.24.5","deepmerge-ts":"8.0.2"}}' > package.json \
 && npm install --omit=dev --no-audit --no-fund --no-package-lock "prisma@$PRISMA_MIGRATION_VERSION" \
 && for spec in mysql2@3.24.5 deepmerge-ts@8.0.2; do \
      name="${spec%@*}"; want="${spec##*@}"; \
      manifests="$(find /opt/prisma/node_modules -type f -path "*/node_modules/$name/package.json")"; \
      test -n "$manifests" || { echo "missing $name in Prisma CLI tree" >&2; exit 1; }; \
      for m in $manifests; do \
        got="$(node -p "require('$m').version")"; \
        test "$got" = "$want" || { echo "$m is $got, expected $want" >&2; exit 1; }; \
      done; \
    done \
 && ln -s /opt/prisma/node_modules/prisma /app/node_modules/prisma \
 && (cd /app && node -e "require.resolve('prisma/config')") \
 && prisma --version \
 && npm cache clean --force \
 && rm /tmp/prisma-migration-version

# Copy dotenv for prisma.config.ts (standalone bundles it into server.js but doesn't keep the module)
COPY --from=builder /app/node_modules/dotenv ./node_modules/dotenv

# Copy PGlite packages for embedded DB mode (when no DATABASE_URL is provided)
COPY --from=builder /pglite-deps/node_modules/@electric-sql ./node_modules/@electric-sql

# Copy entrypoint script + sourced secret-bootstrap library
COPY docker-entrypoint.sh /usr/local/bin/
COPY docker/ensure-secret.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8637

ENV HOSTNAME="0.0.0.0"
ENV PORT=8637

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
