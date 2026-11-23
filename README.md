# Finosauras Earnings Call Intelligence

Finosauras turns earnings-call transcript PDFs into structured JSON and Markdown summaries with page-level evidence. The React dashboard shows an eight-company watchlist, company history, and revision-aware call summaries. An Express API serves the same records, and a WebSocket pushes new publications and corrections to connected browsers.

[Quick start](#quick-start) · [Architecture](#architecture) · [Processing approach](#processing-approach) · [Screenshots](#screenshots) · [API and live events](#api-and-live-events)

## Quick start

With Docker and Docker Compose installed, run this from the repository root.

```sh
docker compose up --build
```

Open [localhost:3000](http://localhost:3000). On a fresh checkout without a private `.env`, the app uses the fixture profile and processes a bundled fictional transcript. Fixture mode needs no exchange credentials or Gemini key. If a private `.env` exists, Compose uses its configured profile.

The Compose volume keeps SQLite, saved summaries, and private PDF and extraction artifacts across container restarts. `docker compose down` keeps the volume. Use `docker compose ps` to check health and `docker compose logs -f app` to follow startup.

### Run without Docker

Install Node.js 22.12 or later in the Node.js 22 release line. Run the following from the repository root.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. The development server proxies API and WebSocket calls to the backend. For a local production-style build, run `npm run build` followed by `npm start` and open [localhost:3000](http://localhost:3000).

## Architecture

![Finosauras architecture showing source adapters, the SQLite job queue, page-aware PDF extraction, Gemini, evidence validation, REST, WebSocket and React](docs/readme-assets/architecture.png)

The supplied diagram predates the directory reorganization. The current project has separate npm lockfiles under `frontend/` and `backend/`, with the shared Zod contracts in [backend/shared](backend/shared/). Each app installs its own dependencies.

| Layer                     | Implementation                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Sources                   | A common filing adapter interface for approved NSE, BSE, and licensed feeds, bundled fixtures, and operator-supplied PDFs |
| Ingestion                 | Node.js and Undici for discovery, bounded downloads, durable job leases, retries, and recovery                            |
| Extraction and validation | PDF.js for text and page positions, Zod for contracts, and application checks for quotes and figures                      |
| Summarization             | Google Gemini via `@google/genai`, local extractive mode, and a deterministic fictional fixture provider                  |
| Persistence and delivery  | SQLite in WAL mode via `better-sqlite3`, a transactional outbox, Express REST, and native WebSockets via `ws`             |
| Browser                   | React, React Router, Vite, and Tailwind CSS                                                                               |

The production container runs one Node.js service. Express serves the built React app, API, and WebSocket on the same origin. SQLite stores jobs, polling cursors, revisions, evidence, and committed events. PDF bytes and page maps live in private storage on the persistent volume.

## Processing approach

1. **Discover and filter.** Source adapters normalize issuer details, filing times, and attachment metadata. Automatic discovery scans eligible filings market-wide on a configurable cadence. The eight-company watchlist is the initial dashboard view.
2. **Download and deduplicate.** The downloader checks permitted hosts, redirects, size, and PDF validity. Attachment identifiers and SHA-256 content hashes help detect repeat filings across sources. Durable cursors and job leases let the pipeline resume after a restart with bounded retries.
3. **Extract and classify.** PDF.js preserves page numbers and text positions for the reading order, tables, and speaker blocks. Content checks distinguish transcript dialogue from cover letters and notices. Unconfirmed call dates and quarters stay unknown. Scanned, damaged, or unsupported files can require review.
4. **Summarize with evidence.** The Gemini path maps page-aware chunks to structured fact candidates and selects supported facts for the final summary. The application checks the schema, source page, quote, and numerical evidence before producing JSON and deterministic Markdown. Local extractive mode builds a summary from the document without a Gemini request.
5. **Commit and publish.** The verified summary, evidence, revision, and outbox event are saved atomically. A correction receives a new summary ID while earlier revisions remain available in company history. WebSocket subscribers receive the committed summary and can recover missed events over REST.

## Screenshots

These captures show historical transcript imports. The source badges identify the reported exchange, and the banner records that automatic exchange polling was disabled. Published times refer to the app's summary publication. Call dates appear separately when confirmed.

### Watchlist

The watchlist shows publication status by company and supports search, sector and quarter filters, and sorting.

![Company watchlist with eight tracked issuers, filters, summary publication times, and source badges](docs/readme-assets/watchlist.png)

### Company history

Company history shows issuer identifiers, verification status, and the available summary revisions.

![ICICI Bank company page with its NSE symbol, BSE code, ISIN, and the Q2 FY23 summary](docs/readme-assets/company-history.png)

### Summary, evidence, and export

The summary view shows the revision, model, validation warnings, and controls to view JSON or copy Markdown.

![ICICI Bank Q2 FY23 summary header with JSON and Markdown controls and validation warnings](docs/readme-assets/summary-overview.png)

Evidence links open the quoted text and PDF page. The captured metrics row appears to pick up `19` from `Covid-19`. This is an example of an extraction error that page evidence helps readers catch.

![Key metrics and management commentary with expandable page evidence](docs/readme-assets/summary-metrics.png)

Sections with no verified items stay empty. Published risk excerpts retain their page links.

![Notable Q&A with no verified items and risk excerpts linked to page two](docs/readme-assets/summary-risks.png)

## Configuration and real transcripts

Use [`.env.example`](.env.example) as the configuration template. Keep credentials in a private `.env`.

| Profile             | Use                                                                        |
| ------------------- | -------------------------------------------------------------------------- |
| `fixture`           | Runs bundled fictional PDFs and a labeled deterministic mock.              |
| `authorized-direct` | Processes approved NSE and BSE feeds or PDFs you obtained with permission. |
| `licensed-feed`     | Uses an approved provider endpoint and its token when required.            |

### Import an existing PDF

For local extraction without a model key, set the following in `.env`.

```dotenv
DATA_MODE=authorized-direct
LIVE_POLLING_ENABLED=false
AI_PROVIDER=extractive
```

Recreate the Compose service with `docker compose up -d --wait` after changing its environment. For the example below, select an authorized PDF for ICICI Bank and enter its original HTTPS exchange attachment URL.

```powershell
$pdf = Read-Host 'Path to the ICICI Bank transcript PDF'
$sourceUrl = Read-Host 'Original HTTPS exchange PDF URL'
if (-not (Test-Path -LiteralPath $pdf -PathType Leaf)) { throw 'PDF file not found' }
docker compose exec -T app npm run db:verify-watchlist
docker compose cp "$pdf" app:/tmp/earnings-call.pdf
docker compose exec -T app npm run ingest:pdf -- --file /tmp/earnings-call.pdf --company ICICIBANK --source-url "$sourceUrl" --authorized --summarize
```

Use `--archive-exchange NSE` or `--archive-exchange BSE` in place of `--source-url` for a local archive with a matching exchange cover page. The app marks its original attachment link as unverified. For Gemini, set `AI_PROVIDER=gemini` and `GEMINI_API_KEY` and use `--summarize` only when you have permission to send that PDF's text to Gemini.

### Enable automatic polling

Set `LIVE_POLLING_ENABLED=true` only after obtaining an approved feed. For `authorized-direct`, supply `NSE_FEED_URL` with `NSE_ACCESS_AUTHORIZED=true`, or `BSE_FEED_URL` with `BSE_ACCESS_AUTHORIZED=true`. For `licensed-feed`, supply `LICENSED_FEED_URL` and `LICENSED_FEED_AUTHORIZED=true`, plus the token if required by the provider. The template also lists attachment host settings.

- `POLL_INTERVAL_SECONDS=300` sets a five-minute cadence.
- `LIVE_MAX_DOCUMENTS_PER_POLL=0` queues all new eligible candidates. Set it to `1` to queue one per scan and mark the remaining candidates as skipped.
- `/api/status` shows source authorization, poll activity, and worker state. WebSocket connectivity reports summary delivery independently of exchange access.

## API and live events

| Endpoint                            | Returns                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/health/ready`             | Backend readiness                                                            |
| `GET /api/status`                   | Source, watcher, job, and provider status                                    |
| `GET /api/watchlist`                | Company availability and latest summary metadata                             |
| `GET /api/companies/{id}/summaries` | Company summary history                                                      |
| `GET /api/summaries/{id}`           | Structured summary, Markdown, revision, and validation metadata              |
| `GET /api/summaries/{id}/markdown`  | Plain Markdown                                                               |
| `GET /api/summaries/{id}/evidence`  | Page, quote, speaker, and claim references                                   |
| `GET /api/events?after_id=0`        | Committed event replay by event ID                                           |
| `WS /ws/summaries`                  | Connection watermark and full `summary.created` and `summary.updated` events |

```mermaid
sequenceDiagram
    participant Browser as React browser
    participant API as Express and WebSocket
    participant DB as SQLite outbox
    Browser->>API: Read /api/events/latest and open /ws/summaries
    API-->>Browser: connected with current event ID
    Note over API,DB: The pipeline commits the verified summary and outbox event together
    API->>DB: Read committed events
    DB-->>API: Summary event with durable ID
    API-->>Browser: Push summary.created or summary.updated
    Note over Browser,API: Following a disconnect the browser opens a new socket
    Browser->>API: GET /api/events?after_id=lastSeen
    API->>DB: Read events after lastSeen
    DB-->>API: Stored events in order
    API-->>Browser: Replay missed events
    Note over Browser: Merge replay and buffered pushes by event ID
```

## Verification and limitations

```sh
npm test
npm run lint
npm run format:check
npm run build
npm run --prefix frontend install:browsers
npm run test:e2e
npm run smoke:compose
```

The latest application verification passed 127 unit and integration tests and two browser tests. Docker startup was healthy, and the six historical summaries remained available after the rebuild. The isolated Compose smoke test exercises WebSocket publication, browser updates, and persistence across container recreation.

Automated exchange ingestion and current-quarter coverage depend on approved feed access. The captured runs use historical imports, and some lack verified original filing links. Text-based PDFs work best. Image-only PDFs, irregular tables, and ambiguous wording can require manual review. Evidence links show what the app used for a claim and make shortcomings such as the captured metric error visible.

## Project layout

```text
backend/                  API, adapters, workers, SQLite, and tests
  shared/                 Shared schemas and event contracts
frontend/                 React UI, Vite, and browser tests
docs/readme-assets/       Supplied screenshots and architecture diagram
compose.yaml              Container, health check, and persistent volume
.env.example              Configuration template
```
