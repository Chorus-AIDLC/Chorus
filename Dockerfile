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
EXPOSE 3000

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

# Install prisma CLI globally for database migrations
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN pnpm add -g prisma

# Copy dotenv for prisma.config.ts (standalone bundles it into server.js but doesn't keep the module)
COPY --from=builder /app/node_modules/dotenv ./node_modules/dotenv

# Copy PGlite packages for embedded DB mode (when no DATABASE_URL is provided)
COPY --from=builder /pglite-deps/node_modules/@electric-sql ./node_modules/@electric-sql

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
