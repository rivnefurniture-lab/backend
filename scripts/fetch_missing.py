#!/usr/bin/env python3
"""
Fetch missing cryptos: BNB, MATIC, FIL, UNI, ICP
"""
import sys
import os

# Add the Downloads folder to path to use the fetcher
sys.path.insert(0, '/Users/andriiliudvichuk/Downloads')

# Change to the backend static directory
os.chdir('/Users/andriiliudvichuk/Projects/backend/static')

from fetcher1m import fetch_symbol_data, OUTPUT_DIR

# Missing symbols from the original 17
MISSING_SYMBOLS = [
    "BNB/USDT",
    "MATIC/USDT", 
    "FIL/USDT",
    "UNI/USDT",
    "ICP/USDT"
]

print("="*60)
print("FETCHING MISSING CRYPTO DATA")
print("="*60)

for symbol in MISSING_SYMBOLS:
    print(f"\n📥 Fetching {symbol}...")
    try:
        fetch_symbol_data(symbol)
        print(f"✅ {symbol} completed!")
    except Exception as e:
        print(f"❌ {symbol} failed: {e}")

print("\n" + "="*60)
print("FETCH COMPLETE")
print("="*60)

