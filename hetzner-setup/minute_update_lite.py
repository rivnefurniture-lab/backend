#!/usr/bin/env python3
"""
Lightweight Minute Data Updater
- Only updates small incremental files
- Merges to main files hourly (when less busy)
- Never loads full 3GB files
"""
import os
import sys
import time
import json
import fcntl
from datetime import datetime, timezone, timedelta
import ccxt
import pandas as pd
import numpy as np

# Configuration
DATA_DIR = '/opt/algotcha/data'
INCREMENTAL_DIR = '/opt/algotcha/data/incremental'
LOG_DIR = '/opt/algotcha/logs'
STATE_FILE = '/opt/algotcha/state/update_state.json'
LOCK_FILE = '/tmp/minute_update.lock'

os.makedirs(LOG_DIR, exist_ok=True)
os.makedirs(INCREMENTAL_DIR, exist_ok=True)
os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)

SYMBOLS = [
    "BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "ADA/USDT",
    "DOGE/USDT", "DOT/USDT", "LINK/USDT", "AVAX/USDT", "NEAR/USDT",
    "LTC/USDT", "TRX/USDT", "HBAR/USDT", "SUI/USDT"
]

exchange = ccxt.binance({
    'enableRateLimit': True,
    'options': {'defaultType': 'spot'}
})


def log(msg, level='INFO'):
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{timestamp}] [{level}] {msg}"
    print(line)
    log_file = os.path.join(LOG_DIR, f"update_{datetime.now().strftime('%Y%m%d')}.log")
    with open(log_file, 'a') as f:
        f.write(line + '\n')


def get_state():
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, 'r') as f:
                return json.load(f)
    except:
        pass
    return {'symbols': {}}


def save_state(state):
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2, default=str)


def calculate_indicators(df):
    """Calculate all indicators for dataframe"""
    if len(df) < 30:
        return df
    
    try:
        # RSI
        delta = df['close'].diff()
        gain = delta.where(delta > 0, 0).rolling(window=14).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=14).mean()
        rs = gain / (loss + 1e-10)
        df['RSI_14'] = 100 - (100 / (1 + rs))
        
        gain28 = delta.where(delta > 0, 0).rolling(window=28).mean()
        loss28 = (-delta.where(delta < 0, 0)).rolling(window=28).mean()
        rs28 = gain28 / (loss28 + 1e-10)
        df['RSI_28'] = 100 - (100 / (1 + rs28))
        
        # SMAs
        df['SMA_20'] = df['close'].rolling(window=20).mean()
        df['SMA_50'] = df['close'].rolling(window=50).mean()
        df['SMA_200'] = df['close'].rolling(window=200).mean()
        
        # EMAs
        df['EMA_12'] = df['close'].ewm(span=12, adjust=False).mean()
        df['EMA_26'] = df['close'].ewm(span=26, adjust=False).mean()
        
        # Bollinger Bands
        bb_sma = df['close'].rolling(window=20).mean()
        bb_std = df['close'].rolling(window=20).std()
        df['BB_upper'] = bb_sma + (bb_std * 2)
        df['BB_lower'] = bb_sma - (bb_std * 2)
        df['BB_middle'] = bb_sma
        df['BB_%B_20_2'] = (df['close'] - df['BB_lower']) / (df['BB_upper'] - df['BB_lower'] + 1e-10)
        df['BB_%B_20_1'] = (df['close'] - (bb_sma - bb_std)) / (2 * bb_std + 1e-10)
        
        # MACD
        df['MACD'] = df['EMA_12'] - df['EMA_26']
        df['MACD_signal'] = df['MACD'].ewm(span=9, adjust=False).mean()
        df['MACD_hist'] = df['MACD'] - df['MACD_signal']
        
        # ATR
        high_low = df['high'] - df['low']
        high_close = abs(df['high'] - df['close'].shift())
        low_close = abs(df['low'] - df['close'].shift())
        tr = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
        df['ATR_14'] = tr.rolling(window=14).mean()
        
        # Stochastic
        low_14 = df['low'].rolling(window=14).min()
        high_14 = df['high'].rolling(window=14).max()
        df['Stoch_K'] = 100 * (df['close'] - low_14) / (high_14 - low_14 + 1e-10)
        df['Stoch_D'] = df['Stoch_K'].rolling(window=3).mean()
        
    except Exception as e:
        log(f"Indicator error: {e}", 'ERROR')
    
    return df


def update_symbol_incremental(symbol, state):
    """Fetch and save incremental data for one symbol"""
    clean = symbol.replace('/', '_')
    inc_file = os.path.join(INCREMENTAL_DIR, f"{clean}_incremental.parquet")
    
    # Get last known timestamp
    last_ts = None
    if clean in state.get('symbols', {}):
        last_ts = pd.Timestamp(state['symbols'][clean].get('last_timestamp'))
    
    if last_ts is None:
        # Check main file
        main_file = os.path.join(DATA_DIR, f"{clean}_all_tf_merged.parquet")
        if os.path.exists(main_file):
            try:
                ts_df = pd.read_parquet(main_file, columns=['timestamp'])
                last_ts = ts_df['timestamp'].max()
                del ts_df
            except:
                last_ts = datetime.now(timezone.utc) - timedelta(hours=1)
        else:
            last_ts = datetime.now(timezone.utc) - timedelta(hours=1)
    
    # Calculate minutes behind
    now = datetime.now(timezone.utc)
    if hasattr(last_ts, 'to_pydatetime'):
        last_ts_utc = last_ts.to_pydatetime().replace(tzinfo=timezone.utc)
    else:
        last_ts_utc = last_ts.replace(tzinfo=timezone.utc)
    
    minutes_behind = int((now - last_ts_utc).total_seconds() / 60)
    
    if minutes_behind < 2:
        return True, 0
    
    # Fetch new data
    try:
        since = int((last_ts_utc - timedelta(minutes=2)).timestamp() * 1000)
        ohlcv = exchange.fetch_ohlcv(symbol, '1m', since=since, limit=min(minutes_behind + 5, 500))
        
        if not ohlcv:
            return True, 0
        
        new_df = pd.DataFrame(ohlcv, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
        new_df['timestamp'] = pd.to_datetime(new_df['timestamp'], unit='ms')
        new_df = new_df[new_df['timestamp'] > last_ts]
        
        if len(new_df) == 0:
            return True, 0
        
        # Calculate indicators
        # Load existing incremental if exists
        if os.path.exists(inc_file):
            existing = pd.read_parquet(inc_file)
            combined = pd.concat([existing.tail(200), new_df], ignore_index=True)
            combined = combined.drop_duplicates(subset=['timestamp'], keep='last')
            combined = combined.sort_values('timestamp')
            combined = calculate_indicators(combined)
            
            # Keep only last 24 hours of incremental data
            cutoff = datetime.now() - timedelta(hours=24)
            combined = combined[combined['timestamp'] > cutoff]
            
            combined.to_parquet(inc_file, index=False)
            new_count = len(new_df)
        else:
            # Calculate indicators on new data
            new_df = calculate_indicators(new_df)
            new_df.to_parquet(inc_file, index=False)
            new_count = len(new_df)
        
        # Update state
        if 'symbols' not in state:
            state['symbols'] = {}
        state['symbols'][clean] = {
            'last_timestamp': str(new_df['timestamp'].max()),
            'last_update': datetime.now().isoformat(),
            'candles_added': new_count
        }
        
        return True, new_count
        
    except Exception as e:
        log(f"{symbol}: Error: {e}", 'ERROR')
        return False, 0


def main():
    """Main update loop"""
    # Acquire lock
    lock_fd = open(LOCK_FILE, 'w')
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except IOError:
        print("Another update running, skipping")
        return
    
    try:
        log("=" * 40)
        log("Starting lightweight minute update...")
        
        state = get_state()
        total_new = 0
        success = 0
        failed = 0
        
        for symbol in SYMBOLS:
            try:
                ok, count = update_symbol_incremental(symbol, state)
                if ok:
                    success += 1
                    total_new += count
                    if count > 0:
                        log(f"✅ {symbol}: +{count} candles")
                else:
                    failed += 1
            except Exception as e:
                log(f"❌ {symbol}: {e}", 'ERROR')
                failed += 1
            
            time.sleep(0.3)  # Rate limit
        
        state['last_run'] = datetime.now().isoformat()
        state['total_success'] = success
        state['total_failed'] = failed
        save_state(state)
        
        if total_new > 0:
            log(f"✅ Done! Added {total_new} candles across {success} symbols")
        else:
            log(f"✅ Done! All symbols up to date")
        
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()


if __name__ == '__main__':
    main()

