-- Additive delivery architecture: existing orders/jobs are retained and mapped.
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_legacy";
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'READY_FOR_PICKUP', 'CANCELLED');
ALTER TABLE "Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "OrderStatus" USING
  (CASE "status"::text WHEN 'COMPLETED' THEN 'READY_FOR_PICKUP' WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'OPEN' END)::"OrderStatus";
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'OPEN';
DROP TYPE "OrderStatus_legacy";

CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'VERIFIED', 'CASH_AUTHORIZED', 'FAILED', 'REFUNDED');
ALTER TABLE "Payment" ALTER COLUMN "status" TYPE "PaymentStatus" USING
  (CASE "status"::text WHEN 'PAID' THEN 'VERIFIED' WHEN 'VERIFIED' THEN 'VERIFIED' WHEN 'CASH_AUTHORIZED' THEN 'CASH_AUTHORIZED' WHEN 'FAILED' THEN 'FAILED' WHEN 'REFUNDED' THEN 'REFUNDED' ELSE 'PENDING' END)::"PaymentStatus";
ALTER TABLE "Payment" ALTER COLUMN "status" SET DEFAULT 'PENDING';

CREATE TYPE "PrintJobStatus" AS ENUM ('QUEUED', 'LEASED', 'DOWNLOADED', 'SUBMITTING', 'SPOOLER_ACCEPTED', 'SIMULATED_COMPLETE', 'FAILED', 'OUTCOME_UNKNOWN', 'CANCELLED');
CREATE TYPE "PhysicalPrintStatus" AS ENUM ('NOT_SUBMITTED', 'SPOOLER_ACCEPTED', 'OUTPUT_CONFIRMED', 'SIMULATED_ONLY', 'UNKNOWN');
ALTER TABLE "PrintJob" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PrintJob" ADD COLUMN "idempotencyKey" TEXT;
UPDATE "PrintJob" SET "idempotencyKey" = 'print:' || "orderId";
ALTER TABLE "PrintJob" ALTER COLUMN "idempotencyKey" SET NOT NULL;
ALTER TABLE "PrintJob" ALTER COLUMN "status" TYPE "PrintJobStatus" USING
  (CASE "status"::text WHEN 'COMPLETED' THEN CASE WHEN "mode"::text='SIMULATED' THEN 'SIMULATED_COMPLETE' ELSE 'SPOOLER_ACCEPTED' END WHEN 'PRINTING' THEN 'SUBMITTING' WHEN 'FAILED' THEN 'FAILED' WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'QUEUED' END)::"PrintJobStatus";
ALTER TABLE "PrintJob" ALTER COLUMN "status" SET DEFAULT 'QUEUED';
ALTER TABLE "PrintJob" ADD COLUMN "physicalStatus" "PhysicalPrintStatus" NOT NULL DEFAULT 'NOT_SUBMITTED';
UPDATE "PrintJob" SET "physicalStatus" = CASE "status"::text WHEN 'SPOOLER_ACCEPTED' THEN 'SPOOLER_ACCEPTED'::"PhysicalPrintStatus" WHEN 'SIMULATED_COMPLETE' THEN 'SIMULATED_ONLY'::"PhysicalPrintStatus" ELSE 'NOT_SUBMITTED'::"PhysicalPrintStatus" END;
ALTER TABLE "PrintJob" ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "PrintJob" ADD COLUMN "claimedById" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "leaseTokenHash" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "PrintJob" ADD COLUMN "submissionStartedAt" TIMESTAMP(3);
ALTER TABLE "PrintJob" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

ALTER TABLE "AgentDevice" ADD COLUMN "printerId" TEXT;
ALTER TABLE "AgentDevice" ADD COLUMN "mode" "PrintMode" NOT NULL DEFAULT 'SIMULATED';
CREATE TABLE "AgentEvent" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "agentDeviceId" TEXT NOT NULL,
  "actorId" TEXT,
  "eventKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrintJob_idempotencyKey_key" ON "PrintJob"("idempotencyKey");
CREATE INDEX "PrintJob_status_nextAttemptAt_createdAt_idx" ON "PrintJob"("status","nextAttemptAt","createdAt");
CREATE INDEX "PrintJob_claimedById_leaseExpiresAt_idx" ON "PrintJob"("claimedById","leaseExpiresAt");
CREATE UNIQUE INDEX "AgentEvent_jobId_eventKey_key" ON "AgentEvent"("jobId","eventKey");
CREATE INDEX "AgentEvent_createdAt_idx" ON "AgentEvent"("createdAt");
ALTER TABLE "AgentDevice" ADD CONSTRAINT "AgentDevice_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "AgentDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PrintJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_agentDeviceId_fkey" FOREIGN KEY ("agentDeviceId") REFERENCES "AgentDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
