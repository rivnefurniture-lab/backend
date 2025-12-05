-- Add profilePhoto to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profilePhoto" TEXT;

-- Add notification preferences to User  
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramEnabled" BOOLEAN DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailNotifications" BOOLEAN DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notifyOnTrade" BOOLEAN DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notifyOnBacktest" BOOLEAN DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notifyOnBalance" BOOLEAN DEFAULT true;

-- Add XP and achievements to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "xp" INTEGER DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "level" INTEGER DEFAULT 1;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "achievements" TEXT;

-- Add subscription fields to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "subscriptionPlan" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "subscriptionStatus" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "subscriptionExpires" TIMESTAMP(3);

-- Create ExchangeConnection table
CREATE TABLE IF NOT EXISTS "ExchangeConnection" (
    "id" SERIAL NOT NULL,
    "exchange" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "passwordEnc" TEXT,
    "testnet" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "userId" INTEGER NOT NULL,

    CONSTRAINT "ExchangeConnection_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint for ExchangeConnection
CREATE UNIQUE INDEX IF NOT EXISTS "ExchangeConnection_userId_exchange_key" ON "ExchangeConnection"("userId", "exchange");

-- Create Strategy table
CREATE TABLE IF NOT EXISTS "Strategy" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "config" TEXT NOT NULL,
    "pairs" TEXT NOT NULL,
    "maxDeals" INTEGER NOT NULL DEFAULT 5,
    "orderSize" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "lastBacktestProfit" DOUBLE PRECISION,
    "lastBacktestDrawdown" DOUBLE PRECISION,
    "lastBacktestSharpe" DOUBLE PRECISION,
    "lastBacktestWinRate" DOUBLE PRECISION,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- Create StrategyRun table
CREATE TABLE IF NOT EXISTS "StrategyRun" (
    "id" SERIAL NOT NULL,
    "config" TEXT NOT NULL,
    "pairs" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'binance',
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "initialBalance" DOUBLE PRECISION NOT NULL,
    "currentBalance" DOUBLE PRECISION,
    "totalProfit" DOUBLE PRECISION,
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "winningTrades" INTEGER NOT NULL DEFAULT 0,
    "maxDrawdown" DOUBLE PRECISION,
    "lastError" TEXT,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "userId" INTEGER NOT NULL,
    "strategyId" INTEGER NOT NULL,

    CONSTRAINT "StrategyRun_pkey" PRIMARY KEY ("id")
);

-- Create Trade table
CREATE TABLE IF NOT EXISTS "Trade" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'market',
    "quantity" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "fee" DOUBLE PRECISION,
    "entryPrice" DOUBLE PRECISION,
    "exitPrice" DOUBLE PRECISION,
    "profitLoss" DOUBLE PRECISION,
    "profitPercent" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "orderId" TEXT,
    "comment" TEXT,
    "marketState" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),
    "userId" INTEGER NOT NULL,
    "strategyRunId" INTEGER,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- Create BacktestResult table
CREATE TABLE IF NOT EXISTS "BacktestResult" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "pairs" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "initialBalance" DOUBLE PRECISION NOT NULL,
    "netProfit" DOUBLE PRECISION NOT NULL,
    "netProfitUsd" DOUBLE PRECISION NOT NULL,
    "maxDrawdown" DOUBLE PRECISION NOT NULL,
    "sharpeRatio" DOUBLE PRECISION NOT NULL,
    "sortinoRatio" DOUBLE PRECISION NOT NULL,
    "winRate" DOUBLE PRECISION NOT NULL,
    "totalTrades" INTEGER NOT NULL,
    "profitFactor" DOUBLE PRECISION NOT NULL,
    "yearlyReturn" DOUBLE PRECISION NOT NULL,
    "chartData" TEXT,
    "trades" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "strategyId" INTEGER,

    CONSTRAINT "BacktestResult_pkey" PRIMARY KEY ("id")
);

-- Create RefundRequest table
CREATE TABLE IF NOT EXISTS "RefundRequest" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paymentId" TEXT,
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

-- Add foreign keys (if they don't exist)
DO $$ BEGIN
    ALTER TABLE "ExchangeConnection" ADD CONSTRAINT "ExchangeConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "StrategyRun" ADD CONSTRAINT "StrategyRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "StrategyRun" ADD CONSTRAINT "StrategyRun_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "Trade" ADD CONSTRAINT "Trade_strategyRunId_fkey" FOREIGN KEY ("strategyRunId") REFERENCES "StrategyRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "BacktestResult" ADD CONSTRAINT "BacktestResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "BacktestResult" ADD CONSTRAINT "BacktestResult_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

