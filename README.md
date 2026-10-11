# QR Print Pakistan

QR Print is a multi-shop QR-based print ordering platform. This repository contains a Next.js customer/shop/admin shell, Express API, PostgreSQL/Prisma data layer, PDF Auto-Fit, payment boundary, and a separately configured Windows print agent. The HP LaserJet 1200 is not assumed to be attached; no physical print test has been performed.

## Repository structure

- `apps/web` — Next.js customer upload/order and owner/admin panel shells.
- `apps/api` — Express API, auth/role checks, tenant isolation, order/payment/job lifecycle, PDF fitting, and authenticated agent routes.
- `apps/api/prisma` — schema and additive migrations.
- `apps/windows-agent` — .NET 8 Windows agent, API client, queue discovery, isolated simulated adapter, and Windows queue adapter.
- `packages/shared` — common types and pricing logic.
- `docker-compose.yml` — local PostgreSQL service.

## Requirements and local setup

- Node.js 20+ and npm.
- PostgreSQL 16 (Docker Desktop or local install).
- .NET 8 SDK on a Windows machine to build the agent and Inno Setup 6 to rebuild the installer. The agent builds cleanly with the .NET 8 SDK; the installer source is `apps/windows-agent/installer/QRPrint.iss`.
- Real queue submission additionally needs an installed Windows printer queue and a trusted PDF renderer. Neither is required for simulated development.

1. Copy `.env.example` to `.env`; replace `JWT_SECRET` and bootstrap passwords. The supplied URLs point only to `qr_print` and `qr_print_test` on the QR Print container's isolated localhost port 5433.
2. Inspect the resolved database names with `npm run db:check-target`. It prints database, host, and port only (no credentials) and fails unless `DATABASE_URL` is `qr_print` and `TEST_DATABASE_URL` is `qr_print_test`. Do not run database-changing commands unless this check passes.
3. Start the isolated QR Print PostgreSQL service: `docker compose up -d postgres`. It uses a separate volume and binds host port 5433. A fresh volume creates `qr_print` and `qr_print_test`; the test database init script only runs on first initialization of an empty volume. Existing PostgreSQL databases and volumes are not reused.
4. Install dependencies: `npm install`.
5. Generate Prisma Client: `npm run db:generate` (the wrapper verifies `DATABASE_URL` is exactly `qr_print`).
6. Review the pending SQL, then apply it when ready: `npm run db:migrate`. The wrapper refuses any target except `qr_print` and blocks reset/data-loss options. If Prisma reports drift or proposes a reset, stop and inspect the target; never approve a reset.
7. Seed the bootstrap owner/shop: `npm run db:seed`. The seed script independently refuses any target except `qr_print`.
8. Apply the checked-in migrations to the isolated test database when preparing integration tests: `npm run db:migrate:test`. This command reads `TEST_DATABASE_URL`, confirms PostgreSQL reports `qr_print_test`, and runs only `prisma migrate deploy`; it never resets or drops data.
9. Start web and API: `npm run dev` (web `http://localhost:3000`; API `http://localhost:4000/health`). Or run `npm run dev:web` and `npm run dev:api` separately.

Use `PRINT_EXECUTION_MODE=simulated` for the development workflow. The API requires this explicit setting and rejects mock payments in production. Development mock payments are selected with `PAYMENT_MODE=mock`; they are explicitly non-production. Cash authorization is off unless `CASH_ORDERS_ENABLED=true`.

`npm test` runs unit tests only; its test discovery explicitly excludes files ending `.integration.test.ts`. Run the database-backed workflow suite with `npm run test:integration`. It uses only `TEST_DATABASE_URL`, requires the URL target and PostgreSQL's live `current_database()` to both be `qr_print_test`, and cleans up only the uniquely identified fixture records created by that run. Prepare its schema with `npm run db:migrate:test` first. Do not run database cleanup or test fixtures against a production/POS database.

## Current order and print flow

1. Customer registers/logs in, uploads a PDF, previews a fitted PDF, and creates an order for a shop’s configured size/color price.
2. The customer creates a payment through the configured adapter. Development mock payment verification changes `Payment.status` only; it does not change `Order.status` or assert printing.
3. A shop owner authorizes cash only when enabled, or queues the order after payment is `VERIFIED`/`CASH_AUTHORIZED`. Queue creation pins the order to a same-shop printer and creates one persistent, idempotent `PrintJob`.
4. An enrolled agent claims an eligible job atomically, downloads its fitted PDF, reports submission and result events. `Order.status`, `Payment.status`, `PrintJob.status`, and `physicalStatus` are separate.
5. A real agent can report Windows spooler acceptance, never physical output. A shop owner must reconcile the result after inspecting paper. Interrupted jobs after submission become `OUTCOME_UNKNOWN` and are never automatically retried until reconciled.

## Agent provisioning and API contract

All agent routes are under `/agent` and require `Authorization: Bearer qpa_…`. Provisioning returns a random credential once; the API persists only its SHA-256 hash. Store it in the Windows agent machine’s environment/secret store, never source control. Agents bind to exactly one active shop, printer, and mode. Every request checks the device, active shop, same-shop printer, assigned printer, and matching job mode. Use HTTPS outside localhost.

Owner/admin provisioning endpoints (normal JWT bearer auth):

- `POST /shops/:id/printers` — JSON `{ "name", "queueName", "connectionType?", "status?", "capabilities?" }`. Treat capabilities as observed reports; do not infer unsupported media/duplex features.
- `POST /shops/:id/agents` — JSON `{ "name", "printerId", "mode": "SIMULATED" | "REAL" }`. Mode must match API `PRINT_EXECUTION_MODE`. Response includes the one-time `credential`; the Windows onboarding flow stores it protected with current-user DPAPI.
- `GET /shops/:id/agents` — owner/admin tenant-scoped connection, queue, and driver-reported capability status.
- `POST /shops/:shopId/agents/:agentId/revoke` — owner/admin tenant-scoped device credential revocation. The old credential immediately stops authenticating.
- `GET /shops/:slug/qr.svg` — public SVG QR for the active shop; encodes only `${PUBLIC_APP_URL}/upload?shop=<slug>`.
- `POST /orders/:id/queue` — JSON `{ "printerId" }`; owner/admin only, eligible verified payment or enabled owner-authorized cash required. Returns a stable print job id and mode.
- `GET /owner/shops` — authenticated shop-owner list of their active shops for secure device onboarding.
- `GET /shops/:id/printers` — owner/admin tenant-scoped printer list for job routing.
- `GET /customer/orders` — authenticated customer’s latest 50 orders with separate order, payment, print-job, and physical-output states.
- `GET /admin/metrics` — super-admin-only shop/order/payment/agent/failed-job counts and verified payment-record total. Mock-mode totals are explicitly development-only and are not real revenue.
- `GET /admin/accounts` — super-admin account list for customer and shop-owner accounts.
- `POST /admin/accounts/shop-owner` — super-admin creates an owner login using a password of at least 12 characters; transmit the temporary password to the owner securely.
- `GET /admin/platform-settings`, `PUT /admin/platform-settings` — persisted commission basis points (0–5000). Estimated commission is informational and does not settle or pay funds.
- `PUT /admin/shops/:id/active` — super-admin-only shop activation/deactivation with an audit record.

Agent bearer routes:

- `POST /agent/heartbeat` — optional body `{ "observedQueue": { "name", "installedQueue", "available", "status", "capabilities?" } }`. Returns device/printer binding, server time, and lease duration; renews active job leases, reaps expired leases, and stores assigned queue status and Windows-driver-reported capability data. A simulated agent sends only a heartbeat and does not access Windows queues.
- `POST /agent/jobs/claim` — no body required. Returns `{ "job": null }` or `{ "job": { "id", "idempotencyKey", "mode", "attempt", "leaseToken", "leaseExpiresAt", "order": … } }`. Claims use a database compare-and-set; only one agent wins.
- `GET /agent/jobs/:id/document` — requires `X-Job-Lease: <leaseToken>`. Local mode returns the fitted PDF. Private Blob mode returns a five-minute signed download URL only after the same authorization and lease checks; the Agent downloads that URL without forwarding its API credential.
- `POST /documents/upload-url` and `POST /documents/complete` — private Blob browser upload handshake. The first returns a short-lived PDF-only URL scoped to the authenticated customer and generated document ID; the second verifies the uploaded PDF before creating its PostgreSQL document record. Local development continues to use `POST /documents` multipart upload.
- `POST /agent/jobs/:id/status` — JSON `{ "eventKey", "status", "leaseToken", "error?", "externalJobId?" }`. Supported events: `SUBMITTING`, `SPOOLER_ACCEPTED`, `SIMULATED_COMPLETE`, `FAILED`, `OUTCOME_UNKNOWN`. Repeat the same event key/status for an idempotent retry. A `SUBMITTING` lease is held until a result; expiration transitions it to `OUTCOME_UNKNOWN`.
- `POST /shops/:shopId/jobs/:jobId/reconcile` — shop owner/admin JSON decision: `confirmed_printed`, `confirmed_not_printed`, or `retry`. Physical confirmation is operator-entered after inspection; unknown output cannot be retried until resolved.

Agent error responses use `{ "error": { "code", "message" } }`; common codes include `AGENT_UNAUTHORIZED`, `JOB_NOT_FOUND`, `LEASE_INVALID`, `INVALID_JOB_TRANSITION`, and `EVENT_KEY_CONFLICT`. Heartbeat interval in the bundled agent is 15 seconds. Expired jobs that had not started submission return to the queue; interrupted submissions become unknown. Safe failures can be retried with bounded backoff and attempt limits.

## Simulated end-to-end workflow

1. Set API `.env` to `PRINT_EXECUTION_MODE=simulated`; run migrations and seed as above.
2. Create/register a printer through the owner API (the `queueName` is descriptive in simulated mode), then enroll an agent for that shop/printer with mode `SIMULATED`.
3. On a Windows agent host with .NET 8 installed, set `QRPRINT_API_URL=http://localhost:4000`, `QRPRINT_AGENT_TOKEN` to the returned one-time credential, and `PRINT_AGENT_MODE=simulated` in the process environment.
4. Run `npm run agent:sim` on a Windows host with the .NET 8 SDK. During onboarding you may choose the `SIMULATED-ONLY` virtual queue, which needs no installed printer. The simulated agent heartbeats, claims/downloads queue jobs, and marks successes `SIMULATED_COMPLETE` / `SIMULATED_ONLY`. It never opens a Windows printer queue and never means that paper printed.
5. For queue tests without .NET, run `npm test` for policy/unit coverage and `npm run test:integration` for persisted HTTP/API workflows. The integration suite exercises concurrent agent claims, shop isolation, pricing/order creation, mock payment separation, idempotent status updates, interrupted submissions, expired leases, retries, and clearly simulated completion. Simulated results are not physical prints.

## Real Windows queue mode and HP first test

Real printing is behind explicit `PRINT_EXECUTION_MODE=real` and must match the enrolled device mode. There is no fallback to the simulated adapter. On the Windows agent machine:

1. Connect/install the HP LaserJet 1200 Series PCL 5 with a suitable Windows driver. Verify the installed queue name in Windows. The agent discovers installed queues and reports an absent/offline queue as unavailable; it does not assume this model’s media or duplex capabilities.
2. Register that observed queue to the intended shop and enroll a `REAL` device while API `PRINT_EXECUTION_MODE=real`.
3. Install a trusted PDF renderer (for example, SumatraPDF), review its documented unattended printing arguments, and set `QRPRINT_PDF_PRINT_COMMAND` and `QRPRINT_PDF_PRINT_ARGS` with `{printer}` and `{file}` placeholders.
4. Set `QRPRINT_API_URL`, the one-time `QRPRINT_AGENT_TOKEN`, and `PRINT_AGENT_MODE=real`; start with `dotnet run --project apps/windows-agent`.
5. Submit a small, non-sensitive test document. The agent reports `SPOOLER_ACCEPTED` only after the renderer returns success. Inspect the physical page, then explicitly reconcile the job as `confirmed_printed`. If the agent disconnects after submission starts, check the queue and paper before choosing a reconciliation action.

The local `--print <queue> <pdf>` diagnostic path is also available, but reports spooler acceptance only. Real output has not been tested in this environment.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection; check target before migrations. |
| `JWT_SECRET` | API session signing secret. |
| `API_PORT`, `NEXT_PUBLIC_API_URL` | API listen port and web API URL. |
| `PAYMENT_MODE` | `mock` in development; mock provider is not production-ready. |
| `PRINT_EXECUTION_MODE` | Required API mode: `simulated` or `real`; no automatic fallback. |
| `AGENT_LEASE_SECONDS`, `PRINT_MAX_ATTEMPTS` | Lease duration (15–300 seconds) and claim retry ceiling. |
| `CASH_ORDERS_ENABLED` | Enables owner-authorized cash order queueing only when `true`. |
| `BOOTSTRAP_*` | Development seed owner/shop and optional admin. |
| `QRPRINT_API_URL`, `QRPRINT_AGENT_TOKEN`, `PRINT_AGENT_MODE` | Windows agent API endpoint (Vercel: `https://<production-project>.vercel.app/api/`), one-time provisioned secret, and matching mode. |
| `QRPRINT_PDF_PRINT_COMMAND`, `QRPRINT_PDF_PRINT_ARGS` | Explicit real-mode PDF renderer executable/arguments. |

## Checks

Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run test:integration` (the last command targets only `qr_print_test`). On Windows with .NET 8 installed, also run `dotnet build apps/windows-agent/QRPrint.Agent.csproj`. Production payment integration, rendered-image preview, service auto-start, and real printer tests remain incomplete.

## Windows shop installer and onboarding

The checked-in installer recipe is a generic reusable shop installer; it contains no shop ID, token, or printer-specific data. It opens a Windows Forms setup wizard. The owner signs in using a provisioned owner account, selects one of their existing shops or creates a shop, scans installed Windows queues, reviews driver-reported capabilities, and enrolls the selected shop/printer/device. The one-time device credential is protected with Windows DPAPI for the current Windows user. The wizard downloads the public QR SVG to `Documents\QRPrint`, supports an optional current-user startup entry, and can start the background agent after setup. The owner panel can download the QR, review heartbeat/queue/capability state, manage eligible orders, and revoke device access. A simulated-only queue is available when no printer is installed and makes no printer capability claims.

Owner accounts must already be provisioned with the `SHOP_OWNER` role; public self-registration creates customer accounts only. The Windows agent and installer have been built successfully in this environment. On another Windows x64 build machine, install the .NET 8 SDK (for example `winget install --id Microsoft.DotNet.SDK.8 --exact`) and Inno Setup 6, reopen PowerShell, then run `.apps\windows-agent\build-installer.ps1` from the repository root. The script publishes a self-contained x64 agent and compiles `dist\installer\QRPrint-Shop-Setup-x64.exe`. Official .NET instructions: [Install .NET on Windows](https://learn.microsoft.com/en-us/dotnet/core/install/windows). Inno Setup downloads: [JRSoftware](https://jrsoftware.org/isdl.php).

For deployment, set `PUBLIC_APP_URL` to the public customer site's HTTPS origin and `NEXT_PUBLIC_API_URL` to the public API's HTTPS origin before building/deploying. Production API startup rejects a localhost/non-HTTPS QR origin; the web client rejects a missing, local, or private API URL rather than embedding localhost in a production QR. This repository has no deployed public origin configured, so mobile-data reachability has not been verified. Verify the deployed customer URL from a phone with Wi-Fi disabled before printing/distributing that shop's QR.

The database-backed workflow suite is registered at `apps/api/src/database-workflows.integration.test.ts`. Before running it, `npm run db:check-target` checks configured names and `npm run test:integration` independently requires `TEST_DATABASE_URL` to name `qr_print_test`; the test itself queries PostgreSQL `current_database()` before creating fixtures and before its fixture-only cleanup. `node apps/api/scripts/verify-db-connections.mjs` connects separately and confirms PostgreSQL's actual database names for both configured QR Print URLs. No migrations or seeds are needed for this code-only onboarding/QR milestone.

`WindowsQueueAdapter` uses Windows installed-queue enumeration and driver-reported `PrinterSettings` information. `Available` means only that the Windows spooler did not report the selected unavailable flags at discovery time. A successful renderer exit is reported as `SPOOLER_ACCEPTED`; neither discovery nor spooler acceptance confirms paper output. Real submission requires the explicit API/device `REAL` mode plus a configured trusted PDF renderer. Simulated mode uses a separate adapter and only reports `SIMULATED_COMPLETE` / `SIMULATED_ONLY`. The HP LaserJet 1200 is not connected or tested here; no model capabilities are assumed.

The installer currently launches interactive onboarding and installs shortcuts; background service installation/auto-start, signed code distribution, a production payment provider, and mobile-data deployment verification remain future work. No physical printer, driver, paper size, duplex feature, or output quality has been tested.

## Single-project Vercel deployment and shop-PC PDF spool

The monorepo is configured for Vercel Services in `vercel.json`: service `api` uses root `apps/api`, Express entrypoint `src/vercel.ts`, and the public `/api/*` rewrite; service `web` uses root `apps/web` and receives the catch-all public rewrite. These are the only two services. The browser calls the public same-origin `/api/*` route, while the shop Agent also reaches that public API route; there are no server-side service-to-service calls, so no bindings are declared. Set the Vercel project Root Directory to the repository root (`.`) and Framework Preset to **Services**. Keep the root npm workspaces and lockfile. Set Production `NEXT_PUBLIC_API_URL=/api` at build time. `PUBLIC_APP_URL` must be the exact stable Production `https://<project>.vercel.app` origin, and production `CORS_ORIGINS` must contain that exact origin. Do not use preview URLs for public shop QR codes.

Vercel production environment variable names:

- `DATABASE_URL`: hosted PostgreSQL connection whose actual database name is `qr_print`; never use localhost or either POS database.
- `JWT_SECRET`: production-only high-entropy signing secret.
- `PUBLIC_APP_URL`: stable Production Vercel HTTPS origin.
- `CORS_ORIGINS`: exact Production origin, HTTPS only.
- `NEXT_PUBLIC_API_URL=/api`: same-origin API route; this value is public.
- `QRPRINT_STORAGE_PROVIDER=vercel-blob`: required. Connect a **private** Vercel Blob store to the Vercel project so the platform provides its storage credentials; never expose those credentials to the browser.
- `VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID`: Vercel-provided runtime/store binding when using the private store. `BLOB_READ_WRITE_TOKEN` is the SDK's alternative store token where OIDC binding is not used. Do not commit or publish any of these values.
- `PRINT_EXECUTION_MODE=real`: explicit production mode; does not imply a printer exists.
- `PAYMENT_MODE`: a real provider is not implemented. Mock payments are forbidden in production; paid checkout remains unavailable until a provider is chosen and implemented. Cash orders remain disabled unless deliberately authorized.
- `CASH_ORDERS_ENABLED`, `AGENT_LEASE_SECONDS`, `PRINT_MAX_ATTEMPTS`: operational gates and job policy.

The API health route is `/api/health`. It checks PostgreSQL and the selected private storage provider. Vercel Functions do not provide durable local filesystem storage, so the filesystem provider is rejected there. Browser PDF uploads use an authenticated, short-lived, path-scoped private Blob upload URL, then call `/api/documents/complete`; the Express Function does not receive the PDF body. The 25 MiB limit is enforced by the signed upload and completion validation. Preview and Agent document routes authorize first, then return short-lived private Blob downloads to avoid sending PDF bytes in a Function response. Agent credentials are never sent to Blob. Documents and essential tenant/order/payment/job records remain in private object storage and hosted PostgreSQL, respectively. The original remains retained centrally until the existing retention policy can safely expire it; offline PCs can retrieve it later.

The Windows Agent retrieves an authorized job only after its shop/printer binding and lease are checked. It saves the PDF encrypted with current-user DPAPI under `%LOCALAPPDATA%\QRPrint\Jobs\<shopId>\<jobId>`, keeps unresolved/retryable/unknown jobs on disk across restarts and outages, and removes data only after a resolved simulated completion or operator-confirmed physical output. Spool enumeration is limited to the enrolled shop ID. Use a dedicated Windows account per shop for OS-level profile isolation. Temporary decrypted submission copies are created only for the renderer and removed after that attempt; encrypted source files remain for reconciliation. No PC filesystem is exposed publicly. Reinstalling under another Windows account does not decrypt existing DPAPI files; retain the old profile for manual recovery.

Vercel Services requests keep their `/api` prefix, which the API adapter strips before dispatch. Local development continues to use the existing separate ports and filesystem storage. Use `NEXT_PUBLIC_API_URL=http://localhost:4000` locally and `QRPRINT_STORAGE_PROVIDER=filesystem`; do not set `VERCEL=1` locally. Public Vercel Services availability, production build behavior, private Blob provisioning, network access to a chosen hosted PostgreSQL provider, and real deployment routing must be verified in the Vercel account before calling this deployed. This repository change does not deploy anything. Vercel Function duration/memory limits still apply to PDF parsing and fitting; very large or complex PDFs may require a separate durable worker service. Vercel Services account access is also a prerequisite; if unavailable, keep Express on a separate persistent host and route `/api` to it rather than dropping the API.
#   Q R p r i n t  
 #   Q R p r i n t  
 #   Q R p r i n t  
 #   Q R p r i n t  
 #   Q R p r i n t  
 #   Q R p r i n t  
 #   Q R p r i n t  
 #   Q R p r i n t  
 