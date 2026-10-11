CREATE TABLE "PlatformSetting" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "commissionBasisPoints" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
);
