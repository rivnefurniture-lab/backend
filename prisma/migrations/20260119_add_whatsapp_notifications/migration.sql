-- Add WhatsApp contact fields to users
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "whatsappNumber" TEXT,
ADD COLUMN IF NOT EXISTS "whatsappEnabled" BOOLEAN DEFAULT false;

-- Add WhatsApp notification target to backtest queue
ALTER TABLE "BacktestQueue"
ADD COLUMN IF NOT EXISTS "notifyWhatsApp" TEXT;
