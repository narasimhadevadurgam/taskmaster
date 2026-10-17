# syntax=docker/dockerfile:1

# ---- builder: install all deps and compile TypeScript to dist/ ----
FROM node:20-slim AS builder
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Copy sources needed to compile (tsconfig includes src, scripts, test; only
# src/ output is shipped, but compiling the whole project keeps types honest).
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build

# Produce a production-only node_modules for the runtime image.
RUN npm prune --omit=dev

# ---- runtime: slim image with only compiled JS + prod deps ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Default upload dir; the entrypoint ensures it exists and is owned by the
# non-root user. Overridable at runtime via the UPLOAD_DIR env var.
ENV UPLOAD_DIR=/app/uploads

# Copy only what the server needs to run: compiled output, migrations (read at
# runtime by the migration runner), package metadata, and prod node_modules.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Run as a non-root user that owns the upload directory.
RUN mkdir -p "$UPLOAD_DIR" \
  && chown -R node:node /app
USER node

EXPOSE 3000

# Migrate-before-serve: apply pending migrations, then start the HTTP+socket
# server. If migrations fail the container exits non-zero (never serves a
# half-migrated schema).
CMD ["sh", "-c", "node dist/src/db/migrate.js && node dist/src/index.js"]
