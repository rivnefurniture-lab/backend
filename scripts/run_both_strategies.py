#!/usr/bin/env python3
"""
Run both Long and Short validated strategies and save metrics.
"""

import os
import sys
import json

os.chdir('/Users/andriiliudvichuk/Projects/backend')
sys.path.insert(0, '/Users/andriiliudvichuk/Projects/backend/scripts')

from backtest2 import run_backtest

# Available pairs
AVAILABLE_PAIRS = [
    "ADA/USDT", "AVAX/USDT", "BTC/USDT", "DOGE/USDT", "DOT/USDT", 
    "ETH/USDT", "HBAR/USDT", "LINK/USDT", "LTC/USDT", "NEAR/USDT", 
    "SOL/USDT", "SUI/USDT", "TRX/USDT", "XRP/USDT"
]

# LONG STRATEGY: RSI > 70 + SMA 50 > 200 → Exit when BB%B < 0.1
LONG_STRATEGY = {
    "strategy_name": "RSI_MA_BB_Long_Strategy",
    "pairs": AVAILABLE_PAIRS,
    "initial_balance": 10000,
    "max_active_deals": 5,
    "trading_fee": 0.1,
    "base_order_size": 1000,
    "start_date": "2024-01-01",
    "end_date": "2025-01-01",
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
    "safety_order_toggle": False,
    "conditions_active": True,
    "take_profit_type": "percentage-total",
    "target_profit": 0,
    "reinvest_profit": 100,
    "stop_loss_toggle": False,
    "risk_reduction": 100,
}

# SHORT STRATEGY: RSI < 30 + SMA 50 < 200 → Exit when BB%B > 0.9
SHORT_STRATEGY = {
    "strategy_name": "RSI_MA_BB_Short_Strategy",
    "pairs": AVAILABLE_PAIRS,
    "initial_balance": 10000,
    "max_active_deals": 5,
    "trading_fee": 0.1,
    "base_order_size": 1000,
    "start_date": "2024-01-01",
    "end_date": "2025-01-01",
    "entry_conditions": [
        {
            "indicator": "RSI", 
            "subfields": {
                "Timeframe": "15m", 
                "RSI Length": 28, 
                "Signal Value": 30, 
                "Condition": "Less Than"  # Mirror: RSI < 30
            }
        }, 
        {
            "indicator": "MA", 
            "subfields": {
                "Timeframe": "1h", 
                "MA Type": "SMA", 
                "Fast MA": 50, 
                "Slow MA": 200, 
                "Condition": "Less Than"  # Mirror: SMA 50 < SMA 200
            }
        }
    ],
    "exit_conditions": [
        {
            "indicator": "BollingerBands", 
            "subfields": {
                "Timeframe": "4h", 
                "BB% Period": 20, 
                "Deviation": 1, 
                "Condition": "Greater Than",  # Mirror: BB%B > 0.9
                "Signal Value": 0.9
            }
        }
    ],
    "safety_order_toggle": False,
    "conditions_active": True,
    "take_profit_type": "percentage-total",
    "target_profit": 0,
    "reinvest_profit": 100,
    "stop_loss_toggle": False,
    "risk_reduction": 100,
}

def run_strategy(name, config):
    print(f"\n{'='*60}")
    print(f"RUNNING: {name}")
    print(f"{'='*60}")
    print(f"Period: {config['start_date']} to {config['end_date']}")
    print(f"Pairs: {len(config['pairs'])}")
    
    result = run_backtest(config)
    
    if result.get("status") == "success":
        metrics = result.get("metrics", {})
        print(f"\n📊 Results:")
        print(f"  Net Profit: {metrics.get('net_profit_usd', 'N/A')}")
        print(f"  Yearly Return: {metrics.get('yearly_return', 0)*100:.2f}%")
        print(f"  Total Trades: {metrics.get('total_trades', 0)}")
        print(f"  Win Rate: {metrics.get('win_rate', 0)*100:.1f}%")
        print(f"  Max Drawdown: {metrics.get('max_drawdown', 0)*100:.2f}%")
        print(f"  Sharpe Ratio: {metrics.get('sharpe_ratio', 0):.2f}")
        print(f"  Sortino Ratio: {metrics.get('sortino_ratio', 0):.2f}")
        print(f"  Profit Factor: {metrics.get('profit_factor', 0)}")
        return metrics
    else:
        print(f"Error: {result.get('message', 'Unknown error')}")
        return None

# Run both strategies
print("\n🚀 Running validated strategies with 5-year backtest period...")

long_metrics = run_strategy("LONG STRATEGY", LONG_STRATEGY)
short_metrics = run_strategy("SHORT STRATEGY", SHORT_STRATEGY)

# Save results for backend to use
results = {
    "long": {
        "name": "RSI + MA + BB Long Strategy",
        "description": "Enters on RSI > 70 (15m) + SMA 50 > SMA 200 (1h), exits on BB%B < 0.1 (4h). Validated on 5 years of data.",
        "metrics": {
            "yearly_return": long_metrics.get("yearly_return", 0) * 100 if long_metrics else 0,
            "sharpe_ratio": long_metrics.get("sharpe_ratio", 0) if long_metrics else 0,
            "sortino_ratio": long_metrics.get("sortino_ratio", 0) if long_metrics else 0,
            "max_drawdown": long_metrics.get("max_drawdown", 0) * 100 if long_metrics else 0,
            "win_rate": long_metrics.get("win_rate", 0) * 100 if long_metrics else 0,
            "total_trades": long_metrics.get("total_trades", 0) if long_metrics else 0,
            "profit_factor": long_metrics.get("profit_factor", 0) if long_metrics else 0,
            "net_profit_usd": long_metrics.get("net_profit_usd", "$0") if long_metrics else "$0",
        }
    },
    "short": {
        "name": "RSI + MA + BB Short Strategy", 
        "description": "Enters on RSI < 30 (15m) + SMA 50 < SMA 200 (1h), exits on BB%B > 0.9 (4h). Mirror strategy for bearish markets.",
        "metrics": {
            "yearly_return": short_metrics.get("yearly_return", 0) * 100 if short_metrics else 0,
            "sharpe_ratio": short_metrics.get("sharpe_ratio", 0) if short_metrics else 0,
            "sortino_ratio": short_metrics.get("sortino_ratio", 0) if short_metrics else 0,
            "max_drawdown": short_metrics.get("max_drawdown", 0) * 100 if short_metrics else 0,
            "win_rate": short_metrics.get("win_rate", 0) * 100 if short_metrics else 0,
            "total_trades": short_metrics.get("total_trades", 0) if short_metrics else 0,
            "profit_factor": short_metrics.get("profit_factor", 0) if short_metrics else 0,
            "net_profit_usd": short_metrics.get("net_profit_usd", "$0") if short_metrics else "$0",
        }
    }
}

# Save to JSON for backend
output_path = "/Users/andriiliudvichuk/Projects/backend/static/validated_strategies.json"
with open(output_path, "w") as f:
    json.dump(results, f, indent=2)

print(f"\n✅ Results saved to {output_path}")
print("\n" + "="*60)
print("SUMMARY")
print("="*60)
print(f"Long Strategy: {results['long']['metrics']['yearly_return']:.1f}% yearly return")
print(f"Short Strategy: {results['short']['metrics']['yearly_return']:.1f}% yearly return")

