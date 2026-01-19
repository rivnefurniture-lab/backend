#!/usr/bin/env python3
"""
Stocks/Commodities Data Fetcher using Yahoo Finance
Fetches OHLCV data and calculates indicators for backtesting
"""
import os
import sys
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import yfinance as yf
import ta
from concurrent.futures import ThreadPoolExecutor, as_completed
import warnings
warnings.filterwarnings('ignore')

# Configuration
DATA_DIR = '/opt/algotcha/data/stocks'
os.makedirs(DATA_DIR, exist_ok=True)

# Stock symbols to fetch - matching frontend config
STOCK_SYMBOLS = [
    # US Stocks - Tech
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',
    # US Stocks - Finance
    'JPM', 'V', 'MA', 'BAC',
    # US Stocks - Other
    'JNJ', 'WMT', 'PG', 'HD', 'DIS', 'NFLX', 'PYPL',
    # ETFs
    'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'EEM',
    # Commodities ETFs
    'GLD', 'SLV', 'USO',
    # Commodities Futures (Yahoo uses =F suffix)
    'GC=F', 'SI=F', 'CL=F', 'NG=F', 'HG=F',
]

# Timeframes to calculate
TIMEFRAMES = ['1h', '4h', '1d']


def log(msg, level='INFO'):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] [{level}] {msg}", flush=True)


def fetch_stock_data(symbol, period='5y', interval='1h'):
    """Fetch OHLCV data from Yahoo Finance"""
    try:
        ticker = yf.Ticker(symbol)
        
        # For 1h data, Yahoo only allows 730 days max
        if interval == '1h':
            df = ticker.history(period='2y', interval='1h')
        else:
            df = ticker.history(period=period, interval=interval)
        
        if df.empty:
            log(f"No data returned for {symbol}", 'WARN')
            return None
            
        df = df.reset_index()
        df.columns = [c.lower() for c in df.columns]
        
        # Rename columns to match our format
        if 'datetime' in df.columns:
            df = df.rename(columns={'datetime': 'timestamp'})
        elif 'date' in df.columns:
            df = df.rename(columns={'date': 'timestamp'})
            
        # Keep only OHLCV columns
        df = df[['timestamp', 'open', 'high', 'low', 'close', 'volume']].copy()
        df['timestamp'] = pd.to_datetime(df['timestamp'])
        
        # Remove timezone info if present
        if df['timestamp'].dt.tz is not None:
            df['timestamp'] = df['timestamp'].dt.tz_localize(None)
            
        df = df.sort_values('timestamp').reset_index(drop=True)
        
        log(f"Fetched {len(df)} rows for {symbol} ({interval})")
        return df
        
    except Exception as e:
        log(f"Error fetching {symbol}: {e}", 'ERROR')
        return None


def calculate_indicators(df, timeframe='1h'):
    """Calculate all technical indicators for a given timeframe"""
    if df is None or df.empty:
        return df
        
    df = df.copy()
    close = df['close']
    high = df['high']
    low = df['low']
    volume = df['volume']
    
    suffix = '' if timeframe == '1h' else f'_{timeframe}'
    
    # RSI with different lengths
    for length in [7, 14, 21]:
        col_name = f'RSI_{length}{suffix}'
        df[col_name] = ta.momentum.RSIIndicator(close, window=length).rsi()
    
    # Moving Averages (SMA and EMA)
    for period in [9, 14, 20, 21, 50, 100, 200]:
        sma_col = f'SMA_{period}{suffix}'
        ema_col = f'EMA_{period}{suffix}'
        df[sma_col] = ta.trend.SMAIndicator(close, window=period).sma_indicator()
        df[ema_col] = ta.trend.EMAIndicator(close, window=period).ema_indicator()
    
    # Bollinger Bands
    for period in [20]:
        for std_dev in [2]:
            bb = ta.volatility.BollingerBands(close, window=period, window_dev=std_dev)
            df[f'BB_%B_{period}_{std_dev}{suffix}'] = bb.bollinger_pband()
            df[f'BB_Upper_{period}_{std_dev}{suffix}'] = bb.bollinger_hband()
            df[f'BB_Lower_{period}_{std_dev}{suffix}'] = bb.bollinger_lband()
    
    # MACD
    for preset in [(12, 26, 9)]:
        fast, slow, signal = preset
        macd = ta.trend.MACD(close, window_slow=slow, window_fast=fast, window_sign=signal)
        df[f'MACD_{fast}_{slow}_{signal}{suffix}'] = macd.macd()
        df[f'MACD_{fast}_{slow}_{signal}_Signal{suffix}'] = macd.macd_signal()
        df[f'MACD_{fast}_{slow}_{signal}_Hist{suffix}'] = macd.macd_diff()
    
    # Stochastic
    for preset in [(14, 3, 3)]:
        k_period, k_smooth, d_smooth = preset
        stoch = ta.momentum.StochasticOscillator(high, low, close, window=k_period, smooth_window=k_smooth)
        df[f'Stochastic_K_{k_period}_{k_smooth}{suffix}'] = stoch.stoch()
        df[f'Stochastic_D_{k_period}_{k_smooth}_{d_smooth}{suffix}'] = stoch.stoch_signal()
    
    # Parabolic SAR
    for preset in [(0.02, 0.2)]:
        step, max_step = preset
        psar = ta.trend.PSARIndicator(high, low, close, step=step, max_step=max_step)
        df[f'PSAR_AF_{step}_Max_{max_step}{suffix}'] = psar.psar()
    
    # Bar close flags (for timeframe checking)
    df[f'Bar_Close_1h'] = True
    df[f'Bar_Close_4h'] = df.index % 4 == 3
    df[f'Bar_Close_1d'] = df.index % 24 == 23
    
    return df


def resample_to_timeframe(df_1h, timeframe):
    """Resample 1h data to higher timeframes"""
    if timeframe == '1h':
        return df_1h.copy()
        
    df = df_1h.copy()
    df = df.set_index('timestamp')
    
    # Map timeframe to pandas offset
    tf_map = {
        '4h': '4H',
        '1d': '1D',
    }
    
    offset = tf_map.get(timeframe, '1H')
    
    resampled = df.resample(offset).agg({
        'open': 'first',
        'high': 'max',
        'low': 'min',
        'close': 'last',
        'volume': 'sum'
    }).dropna()
    
    return resampled.reset_index()


def process_symbol(symbol):
    """Process a single stock symbol - fetch data and calculate indicators"""
    try:
        log(f"Processing {symbol}...")
        
        # Fetch 1h data (base timeframe)
        df_1h = fetch_stock_data(symbol, period='2y', interval='1h')
        if df_1h is None or df_1h.empty:
            return False
            
        # Calculate indicators for 1h
        df_1h = calculate_indicators(df_1h, '1h')
        
        # Resample and calculate indicators for higher timeframes
        for tf in ['4h', '1d']:
            df_tf = resample_to_timeframe(df_1h[['timestamp', 'open', 'high', 'low', 'close', 'volume']], tf)
            df_tf = calculate_indicators(df_tf, tf)
            
            # Merge higher timeframe indicators back to 1h data
            # First, align timestamps
            df_tf = df_tf.set_index('timestamp')
            df_1h = df_1h.set_index('timestamp')
            
            # Get indicator columns (exclude OHLCV)
            indicator_cols = [c for c in df_tf.columns if c not in ['open', 'high', 'low', 'close', 'volume']]
            
            # Forward fill higher timeframe data to 1h
            for col in indicator_cols:
                if col not in df_1h.columns:
                    df_1h[col] = df_tf[col].reindex(df_1h.index, method='ffill')
            
            df_1h = df_1h.reset_index()
            df_tf = df_tf.reset_index()
        
        # Add close columns for different timeframes
        df_1h['close_1h'] = df_1h['close']
        
        # Calculate 4h and 1d close by forward-filling resampled data
        df_4h = resample_to_timeframe(df_1h[['timestamp', 'open', 'high', 'low', 'close', 'volume']], '4h')
        df_1d = resample_to_timeframe(df_1h[['timestamp', 'open', 'high', 'low', 'close', 'volume']], '1d')
        
        df_1h = df_1h.set_index('timestamp')
        df_1h['close_4h'] = df_4h.set_index('timestamp')['close'].reindex(df_1h.index, method='ffill')
        df_1h['close_1d'] = df_1d.set_index('timestamp')['close'].reindex(df_1h.index, method='ffill')
        df_1h = df_1h.reset_index()
        
        # Save to parquet
        output_file = os.path.join(DATA_DIR, f"{symbol}_all_tf_merged.parquet")
        df_1h.to_parquet(output_file, index=False)
        log(f"Saved {symbol} with {len(df_1h)} rows and {len(df_1h.columns)} columns")
        
        return True
        
    except Exception as e:
        log(f"Error processing {symbol}: {e}", 'ERROR')
        import traceback
        traceback.print_exc()
        return False


def fetch_all_stocks(symbols=None, max_workers=4):
    """Fetch and process all stock symbols"""
    if symbols is None:
        symbols = STOCK_SYMBOLS
        
    log(f"Starting to fetch {len(symbols)} stock symbols...")
    
    results = {}
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_symbol = {executor.submit(process_symbol, sym): sym for sym in symbols}
        
        for future in as_completed(future_to_symbol):
            symbol = future_to_symbol[future]
            try:
                success = future.result()
                results[symbol] = success
            except Exception as e:
                log(f"Exception for {symbol}: {e}", 'ERROR')
                results[symbol] = False
    
    # Summary
    successful = sum(1 for v in results.values() if v)
    log(f"Completed: {successful}/{len(symbols)} symbols processed successfully")
    
    return results


def update_stock_data(symbol):
    """Update existing stock data with latest candles"""
    try:
        parquet_file = os.path.join(DATA_DIR, f"{symbol}_all_tf_merged.parquet")
        
        if not os.path.exists(parquet_file):
            log(f"No existing data for {symbol}, fetching full history")
            return process_symbol(symbol)
        
        # Read existing data
        df_existing = pd.read_parquet(parquet_file)
        last_timestamp = df_existing['timestamp'].max()
        
        log(f"{symbol}: Last data at {last_timestamp}")
        
        # Fetch new data
        ticker = yf.Ticker(symbol)
        df_new = ticker.history(start=last_timestamp, interval='1h')
        
        if df_new.empty:
            log(f"{symbol}: No new data")
            return True
            
        df_new = df_new.reset_index()
        df_new.columns = [c.lower() for c in df_new.columns]
        
        if 'datetime' in df_new.columns:
            df_new = df_new.rename(columns={'datetime': 'timestamp'})
        elif 'date' in df_new.columns:
            df_new = df_new.rename(columns={'date': 'timestamp'})
            
        df_new = df_new[['timestamp', 'open', 'high', 'low', 'close', 'volume']].copy()
        df_new['timestamp'] = pd.to_datetime(df_new['timestamp'])
        
        if df_new['timestamp'].dt.tz is not None:
            df_new['timestamp'] = df_new['timestamp'].dt.tz_localize(None)
        
        # Filter to only new rows
        df_new = df_new[df_new['timestamp'] > last_timestamp]
        
        if df_new.empty:
            log(f"{symbol}: No new candles after filtering")
            return True
            
        log(f"{symbol}: Got {len(df_new)} new candles")
        
        # For simplicity, just refetch full data if there are new candles
        return process_symbol(symbol)
        
    except Exception as e:
        log(f"Error updating {symbol}: {e}", 'ERROR')
        return False


def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Fetch stock data from Yahoo Finance')
    parser.add_argument('--symbols', nargs='+', help='Specific symbols to fetch')
    parser.add_argument('--update', action='store_true', help='Update existing data only')
    parser.add_argument('--workers', type=int, default=4, help='Number of parallel workers')
    
    args = parser.parse_args()
    
    symbols = args.symbols if args.symbols else STOCK_SYMBOLS
    
    if args.update:
        log("Updating existing stock data...")
        for symbol in symbols:
            update_stock_data(symbol)
    else:
        log("Fetching full stock data...")
        fetch_all_stocks(symbols, max_workers=args.workers)


if __name__ == '__main__':
    main()

