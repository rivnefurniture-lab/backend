-- CreateTable
CREATE TABLE "BacktestQueue" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "strategyName" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "queuePosition" INTEGER,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "notifyVia" TEXT NOT NULL,
    "notifyEmail" TEXT,
    "notifyTelegram" TEXT,
    "resultId" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BacktestQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BacktestQueue_userId_idx" ON "BacktestQueue"("userId");

-- CreateIndex
CREATE INDEX "BacktestQueue_status_idx" ON "BacktestQueue"("status");

-- CreateIndex
CREATE INDEX "BacktestQueue_createdAt_idx" ON "BacktestQueue"("createdAt");

-- AddForeignKey
ALTER TABLE "BacktestQueue" ADD CONSTRAINT "BacktestQueue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

