# QR Print

QR Print is a multi-shop QR ordering and print queue. A shop installs the Windows agent, selects its printer and prices, and prints its own QR code. Customers scan that QR, upload a PDF, choose the available print options, and submit an order. Shop-owner and platform-admin panels manage settings, orders, and account access.

## Components

- `apps/web` — Next.js customer, owner, and super-admin pages.
- `apps/api` — Express API and Prisma-backed MongoDB persistence.
- `apps/api/prisma/schema.prisma` — MongoDB collections, relations, and indexes.
- `apps/windows-agent` — Windows setup wizard, queue discovery, encrypted local spool, and print submission.
- `packages/shared` — shared types and price calculation.
- `docker-compose.yml` — local MongoDB replica set for development.

## Local setup

Requirements: Node.js 20+, npm, Docker Desktop (or a MongoDB replica set), and .NET 8 on Windows to build/run the shop agent.

1. Rotate any database password shared in chat or another public channel. Create a new MongoDB credential and store it only in your local `.env`.
2. If you do not already have a local `.env`, copy `.env.example` to `.env`. Otherwise update that file without overwriting unrelated local settings. Set `MONGODB_URI` to a MongoDB URL targeting `qr_print`; set `TEST_MONGODB_URI` to a separate `qr_print_test` database. For Atlas, include the database name in the path, e.g. `...mongodb.net/qr_print?retryWrites=true&w=majority`. URL-encode special characters in credentials. Never commit `.env`.
3. Start local MongoDB: `docker compose up -d mongodb`. The local service is a single-node replica set because the order/agent workflows use transactions.
4. Install dependencies: `npm install`.
5. Generate Prisma Client and check configured targets: `npm run db:generate` and `npm run db:check-target`.
6. Synchronize the MongoDB schema: `npm run db:push`. Integration tests use the separate target: `npm run db:push:test`.
7. Provision the bootstrap owner/shop and optional admin with `npm run db:seed`; set the `BOOTSTRAP_*` values first.
8. Start the web app and API: `npm run dev`. The web UI is at `http://localhost:3000`; the API health route is `http://localhost:4000/health`.

Prisma MongoDB uses `db push`, not SQL migrations. The SQL migration files in the repository are historical PostgreSQL artifacts and are not used by the MongoDB setup. Switching the application connection does not automatically copy existing PostgreSQL records; export/import that data separately if it needs to be retained.

## Shop setup and customer flow

1. On the shop PC, install/run `QRPrint.Agent.exe --onboard`. Enter the Production API HTTPS address ending in `/api` (for example `https://qrprint-orcin.vercel.app/api`).
2. Choose **Create a new shop-owner account** or **Sign in to an existing shop-owner account**. New registration creates only a `SHOP_OWNER` account and its first shop; no administrator account or manual approval is required. Existing owners can select one of their shops or create another.
3. Connect the printer and install its Windows driver/add its queue before continuing. After sign-in, the wizard automatically lists installed queues; if you connect the printer while the wizard is open, click **Rescan installed queues**. Select a queue to register and enroll the Windows Agent. Double-sided printing is offered only when the selected driver reports duplex support. If no printer is installed, finish creating the shop and QR without registering a made-up queue; install a printer and run the wizard again to enroll the Agent later.
4. The wizard displays the shop QR generated from the Production `PUBLIC_APP_URL` and lets the owner download it as a PNG. Device credentials are stored using current-user Windows DPAPI. Do not share the owner password or device credential.
5. The owner signs in at `/owner` to set per-page prices, shop details, the print queue, and that shop's customer payment method. Manual-transfer instructions are scoped to the selected shop. A customer scans the shop-specific QR, uploads a PDF without creating an account, chooses print options, pays using the displayed shop details, marks the transfer as sent, and places the order. The claim then appears for the owner to verify.
6. PDFs are stored outside MongoDB. Local API storage is under `QRPRINT_STORAGE_DIR` and defaults to a 30-day cleanup policy. The shop agent holds its spool encrypted on that PC under `%LOCALAPPDATA%\QRPrint\Jobs`; decrypted submission copies are temporary.

The order price continues to use each printed page's configured price; duplex changes how the printer lays out the pages, not the per-page tariff. Owners can account for their local business pricing in the per-page price.

## Print and payment safeguards

- `PRINT_EXECUTION_MODE=simulated` is for development and never prints physical pages. Real mode requires a Windows queue, a trusted PDF renderer, and a driver that reports required capabilities. Renderer arguments must consume `{printer}`, `{file}`, and `{duplex}` (`simplex` or `duplexlong`) so the selected side mode reaches the printer.
- Real jobs are reported as spooler-accepted, not physically printed. The owner must inspect output before confirming it. Interrupted jobs remain outcome-unknown and are not blindly resubmitted.
- Each shop owner configures that shop's manual transfer details in `/owner`. Customers receive only the account name, account number, method, and instructions for the shop they ordered from. On checkout the customer marks the transfer as sent and places the order; that creates a submitted claim for owner review. The owner must check the account statement and verify the claim before the job is queued to the selected Windows Agent.
- If the shop has not enabled manual transfer, development checkout uses a clearly marked mock. Production checkout remains blocked for that shop until its owner configures manual transfer or a real payment provider is implemented and configured. The development mock is not a production payment flow.
- Cash authorization is disabled unless `CASH_ORDERS_ENABLED=true`.
- MongoDB contains application metadata only. PDF bytes stay in the configured private file/object storage; the agent's local spool is DPAPI-encrypted.

## Administration

At `/admin`, a `SUPER_ADMIN` can view registered owner names and emails, printer queues and agent status; provision shop owners; pause/reactivate customer or owner accounts; activate/deactivate shops; review recent audit events; and adjust the platform commission estimate. Payment settings are managed by each shop owner in `/owner`, not by the platform administrator. Deactivating an account blocks new sign-ins and authenticated API/agent calls; shop activation remains an independent control. Shop-owner credentials should be delivered through a secure channel.

## Useful commands

- `npm run db:check-target` — verify `MONGODB_URI` and `TEST_MONGODB_URI` target the expected isolated databases (prints host/database only).
- `npm run db:generate` — generate Prisma Client.
- `npm run db:push` / `npm run db:push:test` — synchronize schema against the checked target.
- `npm run db:seed` — provision bootstrap accounts and shop.
- `npm test` — unit tests.
- `npm run test:integration` — database-backed API workflow tests against `qr_print_test`.
- `npm run lint`, `npm run typecheck`, `npm run build` — workspace checks.
- `dotnet build apps/windows-agent/QRPrint.Agent.csproj` — build the Windows agent on Windows with .NET 8.

Production still requires a secured MongoDB deployment, private persistent document storage, a chosen live payment provider, HTTPS hosting, signed installer distribution, and verification with the shop's actual Windows printer and driver.
#