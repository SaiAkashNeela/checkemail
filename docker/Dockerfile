# ── Build stage ──────────────────────────────────────────────
FROM oven/bun:1-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
COPY data/ ./data/
COPY docker/ ./docker/

# Build TypeScript → dist/
RUN bun run build

# ── Runtime stage ─────────────────────────────────────────────
FROM oven/bun:1-alpine

WORKDIR /app

# Only copy what's needed to run
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/data ./data
COPY --from=builder /app/docker ./docker
COPY package.json ./

ENV PORT=3000
EXPOSE 3000

# Run the server directly with Bun (no compile step needed at runtime)
CMD ["bun", "run", "docker/server.ts"]
