#!/usr/bin/env python3
"""
Fetch missing cryptos: BNB, MATIC, FIL, UNI, ICP
"""
import sys
import os
from datetime import datetime, timezone

# Add the Downloads folder to path to use the fetcher
sys.path.insert(0, '/Users/andriiliudvichuk/Downloads')

# Change to the backend static directory  
os.chdir('/Users/andriiliudvichuk/Projects/backend/static')

from fetcher1m import process_symbol
import ccxt

# Missing symbols from the original 17
MISSING_SYMBOLS = [
    "BNB/USDT",
    "MATIC/USDT", 
    "FIL/USDT",
    "UNI/USDT",
    "ICP/USDT"
]

# Calculate timestamps for 5 years of data
end_ts = int(datetime.now(timezone.utc).timestamp() * 1000)
start_ts = int((datetime.now(timezone.utc) - __import__('datetime').timedelta(days=365*5)).timestamp() * 1000)

ALL_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"]

print("="*60)
print("FETCHING MISSING CRYPTO DATA")
print("="*60)
print(f"Start: {datetime.fromtimestamp(start_ts/1000)}")
print(f"End: {datetime.fromtimestamp(end_ts/1000)}")

exchange = ccxt.binance({
    'enableRateLimit': True,
    'options': {'defaultType': 'spot'}
})

for symbol in MISSING_SYMBOLS:
    print(f"\n📥 Fetching {symbol}...")
    try:
        process_symbol(exchange, symbol, start_ts, end_ts, ALL_TIMEFRAMES)
        print(f"✅ {symbol} completed!")
    except Exception as e:
        print(f"❌ {symbol} failed: {e}")

print("\n" + "="*60)
print("FETCH COMPLETE")
print("="*60)
