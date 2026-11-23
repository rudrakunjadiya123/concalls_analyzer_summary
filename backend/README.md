# Finosauras backend

The backend runs the document pipeline, the read-only REST API, and native WebSocket delivery. The Node.js entry point is `src/index.js`. It opens SQLite, runs migrations, seeds the watchlist, and coordinates startup and shutdown. `src/app.js` configures Express and mounts the API and built frontend.

## Structure

```text
backend/
  src/
    config/          Environment validation and SQLite connection
    routes/          HTTP methods and paths
    controllers/     HTTP input validation and response formatting
    services/        Ingestion, sources, scheduling, worker jobs, PDF, transcript, AI, and summary logic
    models/          SQL migrations, query models, repositories, and outbox reads
    middlewares/     Security headers, query guards, and HTTP error responses
    utils/           Time, storage, hashing, retries, logging, and source transport helpers
    cli/             Operator commands for imports, maintenance, and verification
    ws/              WebSocket transport and committed event delivery
    app.js           Express setup
    index.js         Service startup and shutdown
  shared/            Zod contracts consumed by both apps
  fixtures/          Synthetic PDFs and source responses
  scripts/           Build, smoke, and fixture tooling
  tests/             Unit and integration tests
  .env.example       Configuration template for the private .env file
```

Routes delegate HTTP handling to controllers. Controllers call read models for persisted data. The ingestion services write verified summaries and outbox events, and REST replay and WebSockets read the same committed events.

## Run and verify

Run these commands from the repository root. For custom settings, copy [`.env.example`](.env.example) to `backend/.env` and edit the private file. The default fixture profile runs without credentials.

```sh
npm ci
npm run dev:api
```

```sh
npm test
npm run smoke:stage1
```

Run `npm run start:local` from the repository root to build and serve the dashboard. The [project README](../README.md) covers local startup, PDF imports, live feed configuration, and the REST and WebSocket endpoints.
