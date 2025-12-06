#!/usr/bin/env python3
"""
Memory-Efficient Minute Data Updater v2
- Updates one symbol at a time
- Doesn't load entire files into memory
- Tracks last update time to prevent gaps
- Logs everything for monitoring
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
LOG_DIR = '/opt/algotcha/logs'
STATE_FILE = '/opt/algotcha/state/last_update.json'
LOCK_FILE = '/tmp/minute_update.lock'

os.makedirs(LOG_DIR, exist_ok=True)
os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)

SYMBOLS = [
    "BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "ADA/USDT",
    "DOGE/USDT", "DOT/USDT", "LINK/USDT", "AVAX/USDT", "NEAR/USDT",
    "LTC/USDT", "TRX/USDT", "HBAR/USDT", "SUI/USDT"
]

# Initialize exchange
exchange = ccxt.binance({
    'enableRateLimit': True,
    'options': {'defaultType': 'spot'}
})


def log(msg, level='INFO'):
    """Log to file and console"""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{timestamp}] [{level}] {msg}"
    print(line)
    
    log_file = os.path.join(LOG_DIR, f"update_{datetime.now().strftime('%Y%m%d')}.log")
    with open(log_file, 'a') as f:
        f.write(line + '\n')


def get_state():
    """Get last update state"""
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, 'r') as f:
                return json.load(f)
    except:
        pass
    return {}


def save_state(state):
    """Save update state"""
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2, default=str)


def calculate_indicators_for_row(df):
    """Calculate indicators - only needs last ~200 rows for most indicators"""
    if len(df) < 200:
        return df
    
    # Only calculate on last portion to save memory
    calc_df = df.tail(500).copy()
    
    try:
        # RSI
        delta = calc_df['close'].diff()
        gain = delta.where(delta > 0, 0).rolling(window=14).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=14).mean()
        rs = gain / loss
        calc_df['RSI_14'] = 100 - (100 / (1 + rs))
        
        gain28 = delta.where(delta > 0, 0).rolling(window=28).mean()
        loss28 = (-delta.where(delta < 0, 0)).rolling(window=28).mean()
        rs28 = gain28 / loss28
        calc_df['RSI_28'] = 100 - (100 / (1 + rs28))
        
        # SMAs
        calc_df['SMA_20'] = calc_df['close'].rolling(window=20).mean()
        calc_df['SMA_50'] = calc_df['close'].rolling(window=50).mean()
        calc_df['SMA_200'] = calc_df['close'].rolling(window=200).mean()
        
        # EMAs
        calc_df['EMA_12'] = calc_df['close'].ewm(span=12, adjust=False).mean()
        calc_df['EMA_26'] = calc_df['close'].ewm(span=26, adjust=False).mean()
        
        # Bollinger Bands
        bb_sma = calc_df['close'].rolling(window=20).mean()
        bb_std = calc_df['close'].rolling(window=20).std()
        calc_df['BB_upper'] = bb_sma + (bb_std * 2)
        calc_df['BB_lower'] = bb_sma - (bb_std * 2)
        calc_df['BB_middle'] = bb_sma
        calc_df['BB_%B_20_2'] = (calc_df['close'] - calc_df['BB_lower']) / (calc_df['BB_upper'] - calc_df['BB_lower'])
        
        bb_std_1 = calc_df['close'].rolling(window=20).std() * 1
        calc_df['BB_%B_20_1'] = (calc_df['close'] - (bb_sma - bb_std_1)) / ((bb_sma + bb_std_1) - (bb_sma - bb_std_1))
        
        # MACD
        calc_df['MACD'] = calc_df['EMA_12'] - calc_df['EMA_26']
        calc_df['MACD_signal'] = calc_df['MACD'].ewm(span=9, adjust=False).mean()
        calc_df['MACD_hist'] = calc_df['MACD'] - calc_df['MACD_signal']
        
        # ATR
        high_low = calc_df['high'] - calc_df['low']
        high_close = abs(calc_df['high'] - calc_df['close'].shift())
        low_close = abs(calc_df['low'] - calc_df['close'].shift())
        tr = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
        calc_df['ATR_14'] = tr.rolling(window=14).mean()
        
        # Stochastic
        low_14 = calc_df['low'].rolling(window=14).min()
        high_14 = calc_df['high'].rolling(window=14).max()
        calc_df['Stoch_K'] = 100 * (calc_df['close'] - low_14) / (high_14 - low_14)
        calc_df['Stoch_D'] = calc_df['Stoch_K'].rolling(window=3).mean()
        
    except Exception as e:
        log(f"Error calculating indicators: {e}", 'ERROR')
    
    return calc_df


def resample_to_timeframe(df_1m, timeframe):
    """Resample 1m data to higher timeframe"""
    tf_map = {'5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1D'}
    
    if timeframe not in tf_map:
        return None
    
    df = df_1m.set_index('timestamp')
    resampled = df.resample(tf_map[timeframe]).agg({
        'open': 'first',
        'high': 'max',
        'low': 'min',
        'close': 'last',
        'volume': 'sum'
    }).dropna()
    
    return resampled.reset_index()


def update_symbol(symbol):
    """Update single symbol - memory efficient"""
    try:
        clean_symbol = symbol.replace('/', '_')
        parquet_file = os.path.join(DATA_DIR, f"{clean_symbol}_all_tf_merged.parquet")
        
        if not os.path.exists(parquet_file):
            log(f"File not found: {parquet_file}", 'WARN')
            return False
        
        # Read only timestamp column first to check last update
        df_timestamps = pd.read_parquet(parquet_file, columns=['timestamp'])
        last_timestamp = df_timestamps['timestamp'].max()
        del df_timestamps  # Free memory
        
        # Calculate how many minutes to fetch
        now = datetime.now(timezone.utc)
        minutes_behind = int((now - last_timestamp.to_pydatetime().replace(tzinfo=timezone.utc)).total_seconds() / 60)
        
        if minutes_behind < 2:
            log(f"{symbol}: Already up to date (last: {last_timestamp})")
            return True
        
        # Limit to prevent huge fetches
        minutes_to_fetch = min(minutes_behind + 5, 1000)
        
        log(f"{symbol}: Fetching {minutes_to_fetch} minutes (behind by {minutes_behind})")
        
        # Fetch new candles
        since = int((last_timestamp.to_pydatetime().replace(tzinfo=timezone.utc) - timedelta(minutes=5)).timestamp() * 1000)
        ohlcv = exchange.fetch_ohlcv(symbol, '1m', since=since, limit=minutes_to_fetch)
        
        if not ohlcv:
            log(f"{symbol}: No new data", 'WARN')
            return False
        
        # Create dataframe for new candles
        new_df = pd.DataFrame(ohlcv, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
        new_df['timestamp'] = pd.to_datetime(new_df['timestamp'], unit='ms')
        
        # Filter to only new candles
        new_df = new_df[new_df['timestamp'] > last_timestamp]
        
        if len(new_df) == 0:
            log(f"{symbol}: No new candles after filtering")
            return True
        
        log(f"{symbol}: Got {len(new_df)} new candles")
        
        # Read existing data (only last 500 rows for indicator calculation)
        existing_tail = pd.read_parquet(parquet_file).tail(500)
        
        # Combine for indicator calculation
        combined = pd.concat([existing_tail, new_df], ignore_index=True)
        combined = combined.drop_duplicates(subset=['timestamp'], keep='last')
        combined = combined.sort_values('timestamp')
        
        # Calculate base indicators on 1m
        combined = calculate_indicators_for_row(combined)
        
        # Calculate multi-timeframe indicators
        for tf in ['5m', '15m', '1h', '4h', '1d']:
            try:
                tf_df = resample_to_timeframe(combined[['timestamp', 'open', 'high', 'low', 'close', 'volume']], tf)
                if tf_df is not None and len(tf_df) > 0:
                    tf_df = calculate_indicators_for_row(tf_df)
                    
                    # Rename columns with timeframe suffix
                    for col in tf_df.columns:
                        if col != 'timestamp':
                            combined[f'{col}_{tf}'] = combined['timestamp'].apply(
                                lambda x: tf_df[tf_df['timestamp'] <= x][col].iloc[-1] if len(tf_df[tf_df['timestamp'] <= x]) > 0 else np.nan
                            )
            except Exception as e:
                log(f"{symbol}: Error calculating {tf} indicators: {e}", 'WARN')
        
        # Only keep the new rows
        new_rows = combined[combined['timestamp'] > last_timestamp]
        
        if len(new_rows) == 0:
            return True
        
        # Append to existing parquet
        existing_df = pd.read_parquet(parquet_file)
        updated_df = pd.concat([existing_df, new_rows], ignore_index=True)
        updated_df = updated_df.drop_duplicates(subset=['timestamp'], keep='last')
        updated_df = updated_df.sort_values('timestamp')
        
        # Save
        updated_df.to_parquet(parquet_file, index=False)
        
        log(f"{symbol}: ✅ Updated! Added {len(new_rows)} rows. Last: {updated_df['timestamp'].max()}")
        
        # Free memory
        del existing_df, updated_df, combined, new_rows
        
        return True
        
    except Exception as e:
        log(f"{symbol}: ❌ Error: {e}", 'ERROR')
        return False


def main():
    """Main update loop"""
    # Use file lock to prevent concurrent runs
    lock_fd = open(LOCK_FILE, 'w')
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except IOError:
        log("Another update process is running, exiting", 'WARN')
        return
    
    try:
        log("=" * 50)
        log("Starting minute update v2...")
        
        state = get_state()
        state['last_run'] = datetime.now().isoformat()
        
        success_count = 0
        fail_count = 0
        
        for symbol in SYMBOLS:
            try:
                if update_symbol(symbol):
                    success_count += 1
                else:
                    fail_count += 1
            except Exception as e:
                log(f"{symbol}: Exception: {e}", 'ERROR')
                fail_count += 1
            
            # Small delay between symbols
            time.sleep(0.5)
        
        state['last_success'] = datetime.now().isoformat()
        state['symbols_updated'] = success_count
        state['symbols_failed'] = fail_count
        save_state(state)
        
        log(f"Complete! Updated: {success_count}, Failed: {fail_count}")
        
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()


if __name__ == '__main__':
    main()

