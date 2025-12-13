#!/usr/bin/env ts-node
/**
 * Import real backtest results from 2023-2025 into the database
 * This makes the results accessible via API for the strategies page
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function importBacktestResults() {
  console.log('📊 Importing backtest results from 2023-2025...\n');

  const backtestData = {
    name: 'RSI & Moving Average with Bollinger Bands Exit',
    strategyDescription: 'A conservative strategy that enters on RSI oversold conditions with EMA confirmation, and exits using Bollinger Bands signals.',
    userId: 1, // Admin user
    
    // Strategy configuration
    config: JSON.stringify({
      entry_conditions: [
        {
          indicator: 'RSI',
          subfields: {
            Timeframe: '1h',
            'RSI Length': 21,
            'Signal Value': 20,
            Condition: 'Less Than'
          }
        },
        {
          indicator: 'MA',
          subfields: {
            Timeframe: '1h',
            'MA Type': 'EMA',
            'Fast MA': 20,
            'Slow MA': 100,
            Condition: 'Less Than'
          }
        }
      ],
      exit_conditions: [
        {
          indicator: 'BollingerBands',
          subfields: {
            Timeframe: '1d',
            'BB% Period': 50,
            Deviation: 1,
            Condition: 'Greater Than',
            'Signal Value': 0.1
          }
        }
      ]
    }),
    
    // Trading pairs
    pairs: JSON.stringify([
      'ADA/USDT', 'ATOM/USDT', 'AVAX/USDT', 'BCH/USDT', 'BTC/USDT',
      'DOGE/USDT', 'DOT/USDT', 'ETH/USDT', 'HBAR/USDT', 'LINK/USDT',
      'LTC/USDT', 'NEAR/USDT', 'RENDER/USDT', 'SOL/USDT', 'SUI/USDT',
      'TRX/USDT', 'XRP/USDT'
    ]),
    
    // Period
    startDate: new Date('2023-01-01'),
    endDate: new Date('2025-12-10'),
    
    // Performance metrics
    initialBalance: 5000,
    netProfit: 245.24, // 245.24% return
    netProfitUsd: 12261.76,
    maxDrawdown: 20.0,
    sharpeRatio: 1.13,
    sortinoRatio: 1.22,
    winRate: 78,
    totalTrades: 101,
    profitFactor: 7.80,
    yearlyReturn: 53,
    
    // Chart data - monthly growth
    chartData: JSON.stringify({
      monthlyGrowth: [
        { month: '2023-01', balance: 5075.38, growth: 0.00 },
        { month: '2023-02', balance: 5079.32, growth: 0.08 },
        { month: '2023-03', balance: 5907.29, growth: 16.30 },
        { month: '2023-04', balance: 5943.22, growth: 0.61 },
        { month: '2023-06', balance: 6117.84, growth: 2.94 },
        { month: '2023-07', balance: 6136.31, growth: 0.30 },
        { month: '2023-08', balance: 5713.73, growth: -6.89 },
        { month: '2023-09', balance: 5787.02, growth: 1.28 },
        { month: '2023-10', balance: 5855.37, growth: 1.18 },
        { month: '2023-11', balance: 5855.59, growth: 0.00 },
        { month: '2024-01', balance: 6026.71, growth: 2.92 },
        { month: '2024-03', balance: 6061.72, growth: 0.58 },
        { month: '2024-04', balance: 7018.78, growth: 15.79 },
        { month: '2024-05', balance: 7144.33, growth: 1.79 },
        { month: '2024-06', balance: 7302.77, growth: 2.22 },
        { month: '2024-07', balance: 8359.19, growth: 14.47 },
        { month: '2024-08', balance: 9556.19, growth: 14.32 },
        { month: '2024-09', balance: 9724.71, growth: 1.76 },
        { month: '2024-10', balance: 9720.28, growth: -0.05 },
        { month: '2025-01', balance: 10314.18, growth: 6.11 },
        { month: '2025-02', balance: 10070.33, growth: -2.36 },
        { month: '2025-03', balance: 13212.35, growth: 31.20 },
        { month: '2025-04', balance: 15126.72, growth: 14.49 },
        { month: '2025-06', balance: 15056.08, growth: -0.47 },
        { month: '2025-07', balance: 15152.46, growth: 0.64 },
        { month: '2025-08', balance: 15257.82, growth: 0.70 },
        { month: '2025-09', balance: 15321.88, growth: 0.42 },
        { month: '2025-10', balance: 15893.70, growth: 3.73 },
        { month: '2025-11', balance: 14571.04, growth: -8.32 },
        { month: '2025-12', balance: 15868.02, growth: 8.90 }
      ]
    }),
    
    // Sample trades (first 10 for now, can add more later)
    trades: JSON.stringify([]),
  };

  try {
    // Check if this backtest already exists
    const existing = await prisma.backtestResult.findFirst({
      where: {
        name: backtestData.name,
        startDate: backtestData.startDate,
        endDate: backtestData.endDate,
      }
    });

    if (existing) {
      console.log('⚠️  Backtest already exists, updating...');
      await prisma.backtestResult.update({
        where: { id: existing.id },
        data: backtestData,
      });
      console.log(`✅ Updated backtest ID: ${existing.id}`);
    } else {
      const result = await prisma.backtestResult.create({
        data: backtestData,
      });
      console.log(`✅ Created new backtest ID: ${result.id}`);
    }

    console.log('\n📊 Backtest Results Summary:');
    console.log(`   Name: ${backtestData.name}`);
    console.log(`   Period: ${backtestData.startDate.toISOString().split('T')[0]} to ${backtestData.endDate.toISOString().split('T')[0]}`);
    console.log(`   Net Profit: $${backtestData.netProfitUsd.toFixed(2)} (${backtestData.netProfit.toFixed(2)}%)`);
    console.log(`   Win Rate: ${backtestData.winRate}%`);
    console.log(`   Total Trades: ${backtestData.totalTrades}`);
    console.log(`   Sharpe Ratio: ${backtestData.sharpeRatio}`);
    console.log(`   Sortino Ratio: ${backtestData.sortinoRatio}`);
    console.log(`   Profit Factor: ${backtestData.profitFactor}`);
    console.log(`   Max Drawdown: ${backtestData.maxDrawdown}%`);
    console.log(`   Yearly Return: ${backtestData.yearlyReturn}%`);

  } catch (error) {
    console.error('❌ Error importing backtest:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the import
importBacktestResults()
  .then(() => {
    console.log('\n✅ Import complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Import failed:', error);
    process.exit(1);
  });

