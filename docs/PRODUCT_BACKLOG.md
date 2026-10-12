# QR Print product backlog

Priorities reflect launch risk. Existing routes and code are reused; no Elite POS databases are in scope.

## P0 — Complete the core shop/customer workflows

- Customer-owned order history and status tracking (order, payment, print, and physical states shown separately).
- Owner-visible printer choices, cash authorization when explicitly enabled, job queueing, safe failure retry, and operator reconciliation.
- Super-admin shop activation/approval controls and platform operational/payment summaries with mock-payment labels.
- Verify order, payment, and print actions remain tenant scoped and idempotent in API integration tests.

## P1 — Complete onboarding and operational usability

- Replace console-only Windows enrollment with a guided, accessible Windows setup experience; add safe upgrade, startup/service behavior, and diagnostics.
- Add owner shop-profile/settings management, richer job history, customer-facing upload progress, retry UX, and post-order receipt/status view.
- Add admin account management and persisted commission configuration after agreeing the platform's commission/payment accounting rules.

## P1 — Production infrastructure

- Configure an HTTPS deployment and prove mobile-data access; choose MongoDB Atlas (or another replica-set deployment), private object storage, Redis/BullMQ only if workload needs it, and backup/restore procedures.
- Add real payment provider adapter and signed/idempotent webhooks only after provider credentials/account are available.
- Add production storage retention/deletion, malware/content scanning policy, observability/alerts, and operational recovery runbooks.

## P2 — Final acceptance

- Run the complete deployed customer → payment → shop agent → physical print flow with the shop's installed driver and supported settings.
- Verify physical paper output manually before marking a real job `OUTPUT_CONFIRMED`; spooler acceptance alone is not proof.
- Publish a signed installer and test installation, upgrade, startup, revocation, and uninstall on a clean supported Windows machine.

## Current milestone

Implementing the P0 API and panel workflows using the existing schema. Production payment, hosting/domain, printer hardware acceptance, and installer signing remain external dependencies.

## Completed in this batch

- Customer order history now reads only the signed-in customer's records and keeps payment, order, job, and physical state distinct.
- Shop owners can list tenant-owned printers, authorize cash when enabled, queue paid jobs, retry safely failed jobs, and reconcile unknown real output explicitly.
- Super-admins can activate/deactivate shops and inspect operational totals. Persisted commission basis points default to zero; the dashboard labels computed values as estimates, not settlements.
- These API-only workflows have database integration coverage. The schema change is an additive `PlatformSetting` table migration.
