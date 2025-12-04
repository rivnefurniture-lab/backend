#!/usr/bin/env python3
"""
Hourly Data Updater for Algotcha
Appends new 1-minute data to existing parquet files without replacing old data.
Run via cron or scheduler every hour.
"""

import ccxt
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta
from ta import momentum, trend, volatility
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
import sys

# Force unbuffered output
def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'static')

SYMBOLS = [
    "BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "ADA/USDT",
    "DOGE/USDT", "AVAX/USDT", "LINK/USDT", "DOT/USDT", "NEAR/USDT",
    "LTC/USDT", "HBAR/USDT", "SUI/USDT", "TRX/USDT", "BCH/USDT",
    "RENDER/USDT", "ATOM/USDT"
]

ALL_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"]

def calculate_indicators(df):
    """Calculate all technical indicators on dataframe"""
    # Bar close markers
    df['Bar_Close_1m'] = True
    df['Bar_Close_5m'] = (df['timestamp'].dt.minute % 5 == 4)
    df['Bar_Close_15m'] = (df['timestamp'].dt.minute % 15 == 14)
    df['Bar_Close_1h'] = (df['timestamp'].dt.minute == 59)
    df['Bar_Close_4h'] = (df['timestamp'].dt.hour % 4 == 3) & (df['timestamp'].dt.minute == 59)
    df['Bar_Close_1d'] = (df['timestamp'].dt.hour == 23) & (df['timestamp'].dt.minute == 59)

    # RSI
    for period in [7, 14, 21, 28]:
        df[f'RSI_{period}'] = momentum.RSIIndicator(close=df['close'], window=period).rsi()

    # SMA & EMA
    for period in [5, 10, 14, 20, 25, 30, 50, 75, 100, 150, 200, 250]:
        df[f'SMA_{period}'] = trend.SMAIndicator(close=df['close'], window=period).sma_indicator()
        df[f'EMA_{period}'] = trend.EMAIndicator(close=df['close'], window=period).ema_indicator()

    # Bollinger Bands %B
    for window in [14, 20, 50, 10, 100]:
        for dev in [1, 1.5, 2, 2.5, 3]:
            bb = volatility.BollingerBands(close=df['close'], window=window, window_dev=dev)
            df[f'BB_%B_{window}_{dev}'] = bb.bollinger_pband()

    # MACD
    macd_std = trend.MACD(close=df['close'], window_slow=26, window_fast=12, window_sign=9)
    df['MACD_12_26_9'] = macd_std.macd()
    df['MACD_12_26_9_Signal'] = macd_std.macd_signal()
    df['MACD_12_26_9_Hist'] = macd_std.macd_diff()
    
    for fast, slow, signal in [(6, 20, 9), (9, 30, 9), (15, 35, 9), (18, 40, 9), (10, 26, 9)]:
        macd_temp = trend.MACD(close=df['close'], window_slow=slow, window_fast=fast, window_sign=signal)
        prefix = f"MACD_{fast}_{slow}_{signal}"
        df[prefix] = macd_temp.macd()
        df[f'{prefix}_Signal'] = macd_temp.macd_signal()
        df[f'{prefix}_Hist'] = macd_temp.macd_diff()

    # ATR
    for period in [14, 20, 50]:
        df[f'ATR_{period}'] = volatility.AverageTrueRange(
            high=df['high'], low=df['low'], close=df['close'], window=period
        ).average_true_range()

    # HMA
    for period in [9, 14, 20]:
        period_half = max(2, period // 2)
        wma_half = trend.WMAIndicator(close=df['close'], window=period_half).wma()
        wma_full = trend.WMAIndicator(close=df['close'], window=period).wma()
        raw_hma = 2 * wma_half - wma_full
        hma_period = max(2, int(np.sqrt(period)))
        df[f'HMA_{period}'] = trend.WMAIndicator(close=raw_hma, window=hma_period).wma()

    # Stochastic
    for (k_len, k_smooth, d_smooth) in [(14, 3, 3), (14, 3, 5), (20, 5, 5), (21, 7, 7), (28, 9, 9)]:
        stoch_obj = momentum.StochasticOscillator(
            high=df['high'], low=df['low'], close=df['close'], window=k_len, smooth_window=k_smooth)
        k_line = stoch_obj.stoch()
        d_line_base = stoch_obj.stoch_signal()
        d_line = d_line_base.rolling(d_smooth).mean() if d_smooth > 1 else d_line_base
        df[f'Stochastic_K_{k_len}_{k_smooth}'] = k_line
        df[f'Stochastic_D_{k_len}_{k_smooth}_{d_smooth}'] = d_line

    # Parabolic SAR
    for step, max_step in [(0.02, 0.2), (0.03, 0.2), (0.04, 0.3), (0.05, 0.4), (0.06, 0.5)]:
        psar = trend.PSARIndicator(
            high=df['high'], low=df['low'], close=df['close'], step=step, max_step=max_step)
        df[f'PSAR_AF_{step}_Max_{max_step}'] = psar.psar()

    return df

def resample_df(df, timeframe):
    """Resample 1m data to higher timeframe"""
    rule = {'1m': '1T', '5m': '5T', '15m': '15T', '1h': '1H', '4h': '4H', '1d': '1D'}[timeframe]
    df = df.copy().set_index('timestamp')
    agg = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last', 'volume': 'sum'}
    if timeframe != '1m':
        resampled = df.resample(rule, label='right', closed='right').agg(agg).dropna().reset_index()
        resampled['timestamp'] = resampled['timestamp'] - pd.Timedelta(minutes=1)
    else:
        resampled = df.resample(rule).agg(agg).dropna().reset_index()
    return resampled

def fetch_new_data(exchange, symbol, since_ts):
    """Fetch new 1m data since last timestamp"""
    all_data = []
    limit = 1000
    current_since = since_ts
    end_ts = int(datetime.now(timezone.utc).timestamp() * 1000)
    
    while current_since < end_ts:
        try:
            data = exchange.fetch_ohlcv(symbol, '1m', since=current_since, limit=limit)
            if not data:
                break
            all_data.extend(data)
            last_timestamp = data[-1][0]
            if last_timestamp >= end_ts or last_timestamp <= current_since:
                break
            current_since = last_timestamp + 1
        except Exception as e:
            log(f"  Error fetching {symbol}: {e}")
            break
    
    return all_data

def update_symbol(exchange, symbol, timeframes):
    """Update data for a single symbol"""
    file_path = os.path.join(DATA_DIR, f"{symbol.replace('/', '_')}_all_tf_merged.parquet")
    
    if not os.path.exists(file_path):
        log(f"  {symbol}: File not found, skipping (run full fetcher first)")
        return False
    
    try:
        # Load existing data
        df_existing = pd.read_parquet(file_path)
        df_existing['timestamp'] = pd.to_datetime(df_existing['timestamp'])
        
        # Get last timestamp
        last_ts = df_existing['timestamp'].max()
        since_ts = int(last_ts.timestamp() * 1000) + 60000  # +1 minute
        
        log(f"  {symbol}: Last data at {last_ts}, fetching new...")
        
        # Fetch new data
        new_data = fetch_new_data(exchange, symbol, since_ts)
        
        if not new_data:
            log(f"  {symbol}: No new data")
            return True
        
        # Create DataFrame for new data
        df_new = pd.DataFrame(new_data, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
        df_new['timestamp'] = pd.to_datetime(df_new['timestamp'], unit='ms')
        df_new = df_new.sort_values('timestamp').drop_duplicates(subset=['timestamp'])
        
        log(f"  {symbol}: Got {len(df_new)} new candles")
        
        # Get base columns (OHLCV only) from existing
        base_cols = ['timestamp', 'open', 'high', 'low', 'close', 'volume']
        df_base_existing = df_existing[base_cols].copy()
        
        # Combine old and new base data
        df_combined = pd.concat([df_base_existing, df_new], ignore_index=True)
        df_combined = df_combined.sort_values('timestamp').drop_duplicates(subset=['timestamp']).reset_index(drop=True)
        
        # Recalculate indicators on combined data (needed for continuity)
        log(f"  {symbol}: Recalculating indicators...")
        df_1m = calculate_indicators(df_combined.copy())
        merged_df = df_1m.copy().set_index('timestamp')
        
        # Process higher timeframes
        for tf in timeframes:
            if tf == '1m':
                continue
            df_tf = resample_df(df_combined[['timestamp', 'open', 'high', 'low', 'close', 'volume']], tf)
            df_tf = calculate_indicators(df_tf)
            
            bar_close_col = f"Bar_Close_{tf}"
            if bar_close_col in df_tf.columns:
                df_tf = df_tf[df_tf[bar_close_col]]
            
            df_tf.set_index('timestamp', inplace=True)
            df_tf = df_tf.reindex(merged_df.index, method='ffill')
            df_tf = df_tf.add_suffix(f"_{tf}")
            merged_df = merged_df.join(df_tf, how='left')
        
        merged_df.sort_index(inplace=True)
        merged_df.reset_index(inplace=True)
        
        # Save updated data
        merged_df.to_parquet(file_path, index=False, compression='snappy')
        log(f"  {symbol}: ✓ Updated ({len(merged_df)} total candles)")
        
        return True
        
    except Exception as e:
        log(f"  {symbol}: ERROR - {e}")
        return False

def main():
    log("=" * 50)
    log("HOURLY DATA UPDATE")
    log("=" * 50)
    
    os.makedirs(DATA_DIR, exist_ok=True)
    exchange = ccxt.binance({'enableRateLimit': True})
    
    success_count = 0
    fail_count = 0
    
    for symbol in SYMBOLS:
        log(f"Updating {symbol}...")
        if update_symbol(exchange, symbol, ALL_TIMEFRAMES):
            success_count += 1
        else:
            fail_count += 1
    
    log("=" * 50)
    log(f"COMPLETE: {success_count} success, {fail_count} failed")
    log("=" * 50)

if __name__ == "__main__":
    main()

