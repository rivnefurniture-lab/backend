#!/usr/bin/env python3
"""
Minute Data Updater
Fetches latest 1-minute candle and updates parquet files
Runs via cron every minute
"""
import os
import sys
import time
from datetime import datetime, timezone, timedelta
import ccxt
import pandas as pd
import numpy as np
import ta

DATA_DIR = '/opt/algotcha/data'
LOG_FILE = '/opt/algotcha/logs/update.log'

SYMBOLS = [
    "BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "ADA/USDT",
    "DOGE/USDT", "DOT/USDT", "LINK/USDT", "AVAX/USDT", "NEAR/USDT",
    "LTC/USDT", "TRX/USDT", "HBAR/USDT", "SUI/USDT",
    "BNB/USDT", "MATIC/USDT", "FIL/USDT", "UNI/USDT", "ICP/USDT"
]

ALL_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"]

def log(msg):
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{timestamp}] {msg}"
    print(line)
    with open(LOG_FILE, 'a') as f:
        f.write(line + '\n')

def calculate_indicators(df):
    """Calculate all indicators for a dataframe"""
    try:
        # RSI
        df['RSI_14'] = ta.momentum.RSIIndicator(df['close'], window=14).rsi()
        df['RSI_28'] = ta.momentum.RSIIndicator(df['close'], window=28).rsi()
        
        # SMAs
        df['SMA_20'] = ta.trend.SMAIndicator(df['close'], window=20).sma_indicator()
        df['SMA_50'] = ta.trend.SMAIndicator(df['close'], window=50).sma_indicator()
        df['SMA_200'] = ta.trend.SMAIndicator(df['close'], window=200).sma_indicator()
        
        # EMAs
        df['EMA_12'] = ta.trend.EMAIndicator(df['close'], window=12).ema_indicator()
        df['EMA_26'] = ta.trend.EMAIndicator(df['close'], window=26).ema_indicator()
        
        # Bollinger Bands
        bb = ta.volatility.BollingerBands(df['close'], window=20, window_dev=2)
        df['BB_upper'] = bb.bollinger_hband()
        df['BB_lower'] = bb.bollinger_lband()
        df['BB_middle'] = bb.bollinger_mavg()
        df['BB_%B_20_2'] = bb.bollinger_pband()
        
        # BB with deviation 1
        bb1 = ta.volatility.BollingerBands(df['close'], window=20, window_dev=1)
        df['BB_%B_20_1'] = bb1.bollinger_pband()
        
        # MACD
        macd = ta.trend.MACD(df['close'])
        df['MACD'] = macd.macd()
        df['MACD_signal'] = macd.macd_signal()
        df['MACD_hist'] = macd.macd_diff()
        
        # ATR
        df['ATR_14'] = ta.volatility.AverageTrueRange(df['high'], df['low'], df['close'], window=14).average_true_range()
        
        # Stochastic
        stoch = ta.momentum.StochasticOscillator(df['high'], df['low'], df['close'])
        df['Stoch_K'] = stoch.stoch()
        df['Stoch_D'] = stoch.stoch_signal()
        
    except Exception as e:
        log(f"  ⚠️ Indicator calculation error: {e}")
    
    return df

def resample_timeframe(df_1m, timeframe):
    """Resample 1-minute data to higher timeframe"""
    tf_map = {
        '5m': '5min',
        '15m': '15min',
        '1h': '1h',
        '4h': '4h',
        '1d': '1D'
    }
    
    if timeframe == '1m':
        return df_1m.copy()
    
    rule = tf_map.get(timeframe, '1h')
    
    df = df_1m.resample(rule).agg({
        'open': 'first',
        'high': 'max',
        'low': 'min',
        'close': 'last',
        'volume': 'sum'
    }).dropna()
    
    return df

def update_symbol(exchange, symbol):
    """Update data for a single symbol"""
    try:
        filename = f"{symbol.replace('/', '_')}_all_tf_merged.parquet"
        filepath = os.path.join(DATA_DIR, filename)
        
        # Fetch latest candles
        since = int((datetime.now(timezone.utc) - timedelta(hours=2)).timestamp() * 1000)
        ohlcv = exchange.fetch_ohlcv(symbol, '1m', since=since, limit=120)
        
        if not ohlcv:
            log(f"  ⚠️ {symbol}: No new data")
            return
        
        # Convert to DataFrame
        new_df = pd.DataFrame(ohlcv, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
        new_df['timestamp'] = pd.to_datetime(new_df['timestamp'], unit='ms')
        new_df.set_index('timestamp', inplace=True)
        
        # Load existing data if present
        if os.path.exists(filepath):
            existing_df = pd.read_parquet(filepath)
            if 'timestamp' in existing_df.columns:
                existing_df.set_index('timestamp', inplace=True)
            
            # Merge: keep existing, add new
            df_1m = pd.concat([existing_df, new_df])
            df_1m = df_1m[~df_1m.index.duplicated(keep='last')]
            df_1m.sort_index(inplace=True)
            
            # Keep last 5 years only
            cutoff = datetime.now(timezone.utc) - timedelta(days=365*5)
            df_1m = df_1m[df_1m.index >= cutoff]
        else:
            df_1m = new_df
        
        # Calculate indicators for all timeframes
        result_dfs = []
        for tf in ALL_TIMEFRAMES:
            tf_df = resample_timeframe(df_1m, tf)
            tf_df = calculate_indicators(tf_df)
            
            # Add suffix for non-1m timeframes
            if tf != '1m':
                tf_df = tf_df.add_suffix(f'_{tf}')
            
            result_dfs.append(tf_df)
        
        # Merge all timeframes
        merged = result_dfs[0]
        for tf_df in result_dfs[1:]:
            merged = merged.join(tf_df, how='left')
        
        # Forward fill NaN values
        merged = merged.ffill()
        
        # Reset index and save
        merged.reset_index(inplace=True)
        merged.to_parquet(filepath, index=False)
        
        log(f"  ✅ {symbol}: Updated ({len(merged)} rows)")
        
    except Exception as e:
        log(f"  ❌ {symbol}: {e}")

def main():
    log("=" * 50)
    log("Starting minute update...")
    
    exchange = ccxt.binance({
        'enableRateLimit': True,
        'options': {'defaultType': 'spot'}
    })
    
    for symbol in SYMBOLS:
        update_symbol(exchange, symbol)
        time.sleep(0.5)  # Rate limiting
    
    log("Minute update complete")
    log("=" * 50)

if __name__ == '__main__':
    main()

