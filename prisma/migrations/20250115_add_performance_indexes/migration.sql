-- CreateIndex
CREATE INDEX "Strategy_isPublic_lastBacktestProfit_idx" ON "Strategy"("isPublic", "lastBacktestProfit");

-- CreateIndex
CREATE INDEX "Strategy_isPublic_updatedAt_idx" ON "Strategy"("isPublic", "updatedAt");

-- CreateIndex
CREATE INDEX "BacktestResult_userId_createdAt_idx" ON "BacktestResult"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BacktestResult_netProfitUsd_totalTrades_sharpeRatio_idx" ON "BacktestResult"("netProfitUsd", "totalTrades", "sharpeRatio");

