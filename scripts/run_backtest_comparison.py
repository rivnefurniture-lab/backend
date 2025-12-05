#!/usr/bin/env python3
"""
Run backtest with exact configuration from backtest_summary_metrics.csv
Compare results with the original run.
"""

import os
import sys

# Change to backend directory so paths work correctly
os.chdir('/Users/andriiliudvichuk/Projects/backend')
sys.path.insert(0, '/Users/andriiliudvichuk/Projects/backend/scripts')

from backtest2 import run_backtest

# Available pairs (excluding ATOM, BCH, RENDER which are not downloaded yet)
AVAILABLE_PAIRS = [
    "ADA/USDT", "AVAX/USDT", "BTC/USDT", "DOGE/USDT", "DOT/USDT", 
    "ETH/USDT", "HBAR/USDT", "LINK/USDT", "LTC/USDT", "NEAR/USDT", 
    "SOL/USDT", "SUI/USDT", "TRX/USDT", "XRP/USDT"
]

# Exact configuration from backtest_summary_metrics.csv
payload = {
    "strategy_name": "RSI_MA_BollingerBands_Comparison_Test",
    "pairs": AVAILABLE_PAIRS,
    "initial_balance": 5000,
    "max_active_deals": 5,
    "trading_fee": 0.1,
    "base_order_size": 1000,
    "start_date": "2024-01-01",
    "end_date": "2025-04-01",
    
    # Entry conditions: RSI 28 > 70 on 15m AND SMA 50 > SMA 200 on 1h
    "entry_conditions": [
        {
            "indicator": "RSI", 
            "subfields": {
                "Timeframe": "15m", 
                "RSI Length": 28, 
                "Signal Value": 70, 
                "Condition": "Greater Than"
            }
        }, 
        {
            "indicator": "MA", 
            "subfields": {
                "Timeframe": "1h", 
                "MA Type": "SMA", 
                "Fast MA": 50, 
                "Slow MA": 200, 
                "Condition": "Greater Than"
            }
        }
    ],
    
    # Exit conditions: BB %B < 0.1 on 4h
    "exit_conditions": [
        {
            "indicator": "BollingerBands", 
            "subfields": {
                "Timeframe": "4h", 
                "BB% Period": 20, 
                "Deviation": 1, 
                "Condition": "Less Than", 
                "Signal Value": 0.1
            }
        }
    ],
    
    # Other settings from CSV
    "safety_order_toggle": False,
    "safety_order_size": 0,
    "price_deviation": 0,
    "max_safety_orders_count": 0,
    "safety_order_volume_scale": 0,
    "safety_order_step_scale": 0,
    "safety_conditions": [],
    "price_change_active": False,
    "conditions_active": True,  # This enables exit conditions
    "take_profit_type": "percentage-total",
    "target_profit": 0,
    "trailing_toggle": False,
    "trailing_deviation": 0,
    "minprof_toggle": False,
    "minimal_profit": 0,
    "reinvest_profit": 100,
    "stop_loss_toggle": False,
    "stop_loss_value": 0,
    "stop_loss_timeout": 0,
    "risk_reduction": 100,
    "min_daily_volume": 0,
    "cooldown_between_deals": 0,
    "close_deal_after_timeout": 0
}

print("=" * 60)
print("RUNNING BACKTEST WITH CONFIGURATION FROM CSV")
print("=" * 60)
print(f"Strategy: {payload['strategy_name']}")
print(f"Pairs: {len(AVAILABLE_PAIRS)} (missing ATOM, BCH, RENDER)")
print(f"Period: {payload['start_date']} to {payload['end_date']}")
print(f"Initial Balance: ${payload['initial_balance']}")
print(f"Base Order Size: ${payload['base_order_size']}")
print(f"Max Active Deals: {payload['max_active_deals']}")
print("=" * 60)

# Run backtest
result = run_backtest(payload)

print("\n" + "=" * 60)
print("BACKTEST RESULTS")
print("=" * 60)

if result.get("status") == "success":
    metrics = result.get("metrics", {})
    
    print("\n📊 NEW RUN RESULTS (14 pairs):")
    print(f"  Net Profit: {metrics.get('net_profit_usd', 'N/A')}")
    print(f"  Total Profit: {metrics.get('total_profit_usd', 'N/A')}")
    print(f"  Net Profit %: {metrics.get('net_profit', 0)*100:.2f}%")
    print(f"  Yearly Return: {metrics.get('yearly_return', 0)*100:.2f}%")
    print(f"  Total Trades: {metrics.get('total_trades', 0)}")
    print(f"  Win Rate: {metrics.get('win_rate', 0)*100:.1f}%")
    print(f"  Max Drawdown: {metrics.get('max_drawdown', 0)*100:.2f}%")
    print(f"  Sharpe Ratio: {metrics.get('sharpe_ratio', 0):.2f}")
    print(f"  Sortino Ratio: {metrics.get('sortino_ratio', 0):.2f}")
    print(f"  Profit Factor: {metrics.get('profit_factor', 0)}")
    print(f"  Avg Deal Duration: {metrics.get('avg_deal_duration', 'N/A')}")
    
    print("\n📊 ORIGINAL RUN RESULTS (17 pairs from CSV):")
    print(f"  Net Profit: $7424.77")
    print(f"  Total Profit: $6489.10")
    print(f"  Net Profit %: 148.50%")
    print(f"  Yearly Return: 118%")
    print(f"  Total Trades: 201")
    print(f"  Win Rate: 39%")
    print(f"  Max Drawdown: 30.03%")
    print(f"  Sharpe Ratio: 1.42")
    print(f"  Sortino Ratio: 2.04")
    print(f"  Profit Factor: 1.95")
    print(f"  Avg Deal Duration: 4 days, 0 hours, 45 minutes")
    
    print("\n" + "=" * 60)
    print("COMPARISON NOTES:")
    print("=" * 60)
    print("- New run uses 14 pairs (missing ATOM, BCH, RENDER)")
    print("- Original used 17 pairs")
    print("- Results should be somewhat similar but not identical")
    print("- Differences expected due to 3 missing pairs")
else:
    print(f"Error: {result.get('message', 'Unknown error')}")

print("\n✅ Backtest complete!")

