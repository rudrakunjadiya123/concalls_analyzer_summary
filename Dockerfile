FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app
# Both app installs use the same checked-in API contracts.
COPY backend/shared ./backend/shared
COPY frontend/.npmrc frontend/package*.json ./frontend/
RUN --mount=type=cache,target=/root/.npm npm --prefix frontend ci --no-audit --no-fund
COPY frontend ./frontend
RUN npm --prefix frontend run build

FROM node:22-bookworm-slim AS backend-build
WORKDIR /app

# Build tooling is needed only when the SQLite module must compile from source.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY backend/shared ./backend/shared
COPY backend/.npmrc backend/package*.json ./backend/
RUN --mount=type=cache,target=/root/.npm npm --prefix backend ci --omit=dev --no-audit --no-fund
COPY backend ./backend
RUN node backend/scripts/check-api-imports.js

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
COPY package.json ./
COPY --from=backend-build /app/backend ./backend
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "backend/src/index.js"]
