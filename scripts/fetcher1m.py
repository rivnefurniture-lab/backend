import ccxt
import pandas as pd
import numpy as np
from datetime import datetime, timezone
from ta import momentum, trend, volatility
from concurrent.futures import ThreadPoolExecutor, as_completed
import sys

# Force unbuffered output
def log(msg):
    print(msg, flush=True)

# ----- FUNCTIONS FOR INDICATORS -----
def calculate_indicators(df):
    # Create boolean columns marking bar closes for various timeframes
    df['Bar_Close_1m'] = True
    df['Bar_Close_5m'] = (df['timestamp'].dt.minute % 5 == 4)
    df['Bar_Close_15m'] = (df['timestamp'].dt.minute % 15 == 14)
    df['Bar_Close_1h'] = (df['timestamp'].dt.minute == 59)
    df['Bar_Close_4h'] = (df['timestamp'].dt.hour % 4 == 3) & (df['timestamp'].dt.minute == 59)
    df['Bar_Close_1d'] = (df['timestamp'].dt.hour == 23) & (df['timestamp'].dt.minute == 59)

    # 1. RSI
    for period in [7, 14, 21, 28]:
        df[f'RSI_{period}'] = momentum.RSIIndicator(close=df['close'], window=period).rsi()

    # 2. SMA & EMA
    for period in [5, 10, 14, 20, 25, 30, 50, 75, 100, 150, 200, 250]:
        df[f'SMA_{period}'] = trend.SMAIndicator(close=df['close'], window=period).sma_indicator()
        df[f'EMA_{period}'] = trend.EMAIndicator(close=df['close'], window=period).ema_indicator()

    # 3. Bollinger Bands %B
    for window in [14, 20, 50, 10, 100]:
        for dev in [1, 1.5, 2, 2.5, 3]:
            bb = volatility.BollingerBands(close=df['close'], window=window, window_dev=dev)
            col_name = f'BB_%B_{window}_{dev}'
            df[col_name] = bb.bollinger_pband()

    # 4. MACD
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

    # 5. Average True Range (ATR)
    for period in [14, 20, 50]:
        df[f'ATR_{period}'] = volatility.AverageTrueRange(
            high=df['high'], low=df['low'], close=df['close'], window=period
        ).average_true_range()

    # 6. Hull Moving Average (HMA)
    for period in [9, 14, 20]:
        # Calculate WMA of 2 * WMA(period/2) - WMA(period)
        period_half = max(2, period // 2)
        wma_half = trend.WMAIndicator(close=df['close'], window=period_half).wma()
        wma_full = trend.WMAIndicator(close=df['close'], window=period).wma()
        raw_hma = 2 * wma_half - wma_full
        # WMA of the raw HMA with period sqrt(period)
        hma_period = max(2, int(np.sqrt(period)))
        df[f'HMA_{period}'] = trend.WMAIndicator(close=raw_hma, window=hma_period).wma()

        #Stochastic Oscillator
    for (k_len, k_smooth, d_smooth) in [(14, 3, 3), (14, 3, 5), (20, 5, 5), (21, 7, 7), (28, 9, 9)]:
        stoch_obj = momentum.StochasticOscillator(
            high=df['high'], low=df['low'], close=df['close'], window=k_len, smooth_window=k_smooth)
        k_line = stoch_obj.stoch()
        d_line_base = stoch_obj.stoch_signal()
        d_line = d_line_base.rolling(d_smooth).mean() if d_smooth > 1 else d_line_base
        df[f'Stochastic_K_{k_len}_{k_smooth}'] = k_line
        df[f'Stochastic_D_{k_len}_{k_smooth}_{d_smooth}'] = d_line

    # Heiken Ashi
    # ha_df = df.copy()
    # ha_df['ha_close'] = (ha_df['open'] + ha_df['high'] + ha_df['low'] + ha_df['close']) / 4
    # ha_open = []
    # for i in range(len(ha_df)):
    #     if i == 0:
    #         ha_open.append((ha_df['open'].iloc[0] + ha_df['close'].iloc[0]) / 2)
    #     else:
    #         ha_open.append((ha_open[i-1] + ha_df['ha_close'].iloc[i-1]) / 2)
    # ha_df['ha_open'] = ha_open
    # ha_df['ha_high'] = ha_df[['high', 'ha_close', 'ha_open']].max(axis=1)
    # ha_df['ha_low']  = ha_df[['low', 'ha_close', 'ha_open']].min(axis=1)
    # df['HA_Open']  = ha_df['ha_open']
    # df['HA_High']  = ha_df['ha_high']
    # df['HA_Low']   = ha_df['ha_low']
    # df['HA_Close'] = ha_df['ha_close']

    # #Parabolic SAR
    for step, max_step in [(0.02, 0.2), (0.03, 0.2), (0.04, 0.3), (0.05, 0.4), (0.06, 0.5)]:
        psar = trend.PSARIndicator(
            high=df['high'], low=df['low'], close=df['close'], step=step, max_step=max_step)
        df[f'PSAR_AF_{step}_Max_{max_step}'] = psar.psar()

    return df

def map_rating(value):
    if value > 0.5:
        return "Strong Buy"
    elif value > 0.1:
        return "Buy"
    elif value >= -0.1:
        return "Neutral"
    elif value >= -0.5:
        return "Sell"
    else:
        return "Strong Sell"

def calculate_technical_ratings(df):
    def is_rising(series):
        return (series - series.shift(1)) > 0

    def is_falling(series):
        return (series - series.shift(1)) < 0

    indicators = {}
    for col in ['close', 'high', 'low']:
        if col not in df.columns:
            raise ValueError(f"Missing required column: {col}")

    new_indicators = []

    # EMA_13 for Bull/Bear Power
    if 'EMA_13' not in df.columns:
        ema_13 = trend.EMAIndicator(close=df['close'], window=13).ema_indicator()
        new_indicators.append(ema_13.rename('EMA_13'))

    if 'BullPower' not in df.columns:
        ema = df['EMA_13'] if 'EMA_13' in df.columns else ema_13
        bull_power = df['high'] - ema
        new_indicators.append(bull_power.rename('BullPower'))
    if 'BearPower' not in df.columns:
        ema = df['EMA_13'] if 'EMA_13' in df.columns else ema_13
        bear_power = df['low'] - ema
        new_indicators.append(bear_power.rename('BearPower'))

    if 'RSI_14' not in df.columns:
        rsi_14 = momentum.RSIIndicator(close=df['close'], window=14).rsi()
        new_indicators.append(rsi_14.rename('RSI_14'))

    if 'Stochastic_K_14_3' not in df.columns or 'Stochastic_D_14_3_3' not in df.columns:
        stoch = momentum.StochasticOscillator(
            high=df['high'], low=df['low'], close=df['close'], window=14, smooth_window=3)
        new_indicators.append(stoch.stoch().rename('Stochastic_K_14_3'))
        new_indicators.append(stoch.stoch_signal().rename('Stochastic_D_14_3_3'))

    if 'CCI_20' not in df.columns:
        cci_20 = trend.CCIIndicator(
            high=df['high'], low=df['low'], close=df['close'], window=20).cci()
        new_indicators.append(cci_20.rename('CCI_20'))

    if not all(x in df.columns for x in ['ADX_14', '+DI_14', '-DI_14']):
        adx = trend.ADXIndicator(
            high=df['high'], low=df['low'], close=df['close'], window=14)
        new_indicators.append(adx.adx().rename('ADX_14'))
        new_indicators.append(adx.adx_pos().rename('+DI_14'))
        new_indicators.append(adx.adx_neg().rename('-DI_14'))

    if 'AO' not in df.columns:
        ao = momentum.AwesomeOscillatorIndicator(
            high=df['high'], low=df['low']).awesome_oscillator()
        new_indicators.append(ao.rename('AO'))

    if 'Momentum_10' not in df.columns:
        momentum_10 = df['close'] - df['close'].shift(10)
        new_indicators.append(momentum_10.rename('Momentum_10'))

    if 'MACD_12_26_9' not in df.columns or 'MACD_12_26_9_Signal' not in df.columns:
        macd = trend.MACD(
            close=df['close'], window_slow=26, window_fast=12, window_sign=9)
        new_indicators.append(macd.macd().rename('MACD_12_26_9'))
        new_indicators.append(macd.macd_signal().rename('MACD_12_26_9_Signal'))

    if 'StochRSI_K' not in df.columns or 'StochRSI_D' not in df.columns:
        stochrsi = momentum.StochRSIIndicator(
            close=df['close'], window=14, smooth1=3, smooth2=3)
        new_indicators.append(stochrsi.stochrsi().rename('StochRSI_K'))
        new_indicators.append(stochrsi.stochrsi_d().rename('StochRSI_D'))

    if 'Williams_%R' not in df.columns:
        williams_r = momentum.WilliamsRIndicator(
            high=df['high'], low=df['low'], close=df['close'], lbp=14).williams_r()
        new_indicators.append(williams_r.rename('Williams_%R'))

    if 'UO' not in df.columns:
        uo = momentum.UltimateOscillator(
            high=df['high'], low=df['low'], close=df['close'],
            window1=7, window2=14, window3=28).ultimate_oscillator()
        new_indicators.append(uo.rename('UO'))

    if not all(x in df.columns for x in ['Ichimoku_lead1', 'Ichimoku_lead2', 'Ichimoku_base', 'Ichimoku_conversion']):
        ichimoku = trend.IchimokuIndicator(
            high=df['high'], low=df['low'], window1=9, window2=26, window3=52)
        new_indicators.append(ichimoku.ichimoku_a().rename('Ichimoku_lead1'))
        new_indicators.append(ichimoku.ichimoku_b().rename('Ichimoku_lead2'))
        new_indicators.append(ichimoku.ichimoku_base_line().rename('Ichimoku_base'))
        new_indicators.append(ichimoku.ichimoku_conversion_line().rename('Ichimoku_conversion'))

    if new_indicators:
        df = pd.concat([df] + new_indicators, axis=1)

    # --- Trend (MA/Ichimoku) Signals ---
    ma_signals_keys = []
    ma_columns = [col for col in df.columns if col.startswith('SMA_') or
                  col.startswith('EMA_') or col.startswith('VWMA_') or col.startswith('HMA_')]
    for col in ma_columns:
        key = f"ma_{col}"
        indicators[key] = ((df['close'] > df[col]).astype(int) - (df['close'] < df[col]).astype(int))
        ma_signals_keys.append(key)

    if all(x in df.columns for x in ['Ichimoku_lead1', 'Ichimoku_lead2', 'Ichimoku_base', 'Ichimoku_conversion']):
        conditions_buy = ((df['Ichimoku_lead1'] > df['Ichimoku_lead2']) &
                          (df['Ichimoku_base'] > df['Ichimoku_lead1']) &
                          (df['Ichimoku_conversion'] > df['Ichimoku_base']) &
                          (df['close'] > df['Ichimoku_conversion']))
        conditions_sell = ((df['Ichimoku_lead1'] < df['Ichimoku_lead2']) &
                           (df['Ichimoku_base'] < df['Ichimoku_lead1']) &
                           (df['Ichimoku_conversion'] < df['Ichimoku_base']) &
                           (df['close'] < df['Ichimoku_conversion']))
        indicators['ichimoku_signal'] = np.where(conditions_buy, 1, np.where(conditions_sell, -1, 0))
    else:
        indicators['ichimoku_signal'] = 0
    ma_signals_keys.append('ichimoku_signal')

    # --- Oscillator Signals ---
    osc_signals_keys = []
    if 'RSI_14' in df.columns:
        indicators['rsi_signal'] = np.where((df['RSI_14'] < 30) & is_rising(df['RSI_14']), 1,
                                            np.where((df['RSI_14'] > 70) & is_falling(df['RSI_14']), -1, 0))
    else:
        indicators['rsi_signal'] = 0
    osc_signals_keys.append('rsi_signal')

    if 'Stochastic_K_14_3' in df.columns and 'Stochastic_D_14_3_3' in df.columns:
        indicators['stochastic_signal'] = np.where(
            (df['Stochastic_K_14_3'] < 20) & (df['Stochastic_D_14_3_3'] < 20) &
            (df['Stochastic_K_14_3'] > df['Stochastic_D_14_3_3']),
            1,
            np.where((df['Stochastic_K_14_3'] > 80) & (df['Stochastic_D_14_3_3'] > 80) &
                     (df['Stochastic_K_14_3'] < df['Stochastic_D_14_3_3']),
                     -1, 0))
    else:
        indicators['stochastic_signal'] = 0
    osc_signals_keys.append('stochastic_signal')

    if 'CCI_20' in df.columns:
        indicators['cci_signal'] = np.where((df['CCI_20'] < -100) & is_rising(df['CCI_20']), 1,
                                            np.where((df['CCI_20'] > 100) & is_falling(df['CCI_20']), -1, 0))
    else:
        indicators['cci_signal'] = 0
    osc_signals_keys.append('cci_signal')

    if all(x in df.columns for x in ['ADX_14', '+DI_14', '-DI_14']):
        indicators['adx_signal'] = np.where((df['ADX_14'] > 25) & (df['+DI_14'] > df['-DI_14']), 1,
                                            np.where((df['ADX_14'] > 25) & (df['+DI_14'] < df['-DI_14']), -1, 0))
    else:
        indicators['adx_signal'] = 0
    osc_signals_keys.append('adx_signal')

    if 'AO' in df.columns:
        ao_prev = df['AO'].shift(1)
        indicators['ao_signal'] = np.where((df['AO'] > 0) & ((ao_prev <= 0) | (df['AO'] > ao_prev)), 1,
                                           np.where((df['AO'] < 0) & ((ao_prev >= 0) | (df['AO'] < ao_prev)), -1, 0))
    else:
        indicators['ao_signal'] = 0
    osc_signals_keys.append('ao_signal')

    if 'Momentum_10' in df.columns:
        indicators['momentum_signal'] = np.where(is_rising(df['Momentum_10']), 1,
                                                 np.where(is_falling(df['Momentum_10']), -1, 0))
    else:
        indicators['momentum_signal'] = 0
    osc_signals_keys.append('momentum_signal')

    if 'MACD_12_26_9' in df.columns and 'MACD_12_26_9_Signal' in df.columns:
        indicators['macd_signal'] = np.where(df['MACD_12_26_9'] > df['MACD_12_26_9_Signal'], 1,
                                             np.where(df['MACD_12_26_9'] < df['MACD_12_26_9_Signal'], -1, 0))
    else:
        indicators['macd_signal'] = 0
    osc_signals_keys.append('macd_signal')

    if 'StochRSI_K' in df.columns and 'StochRSI_D' in df.columns:
        price_diff = df['close'] - df['close'].shift(1)
        uptrend = price_diff > 0
        downtrend = price_diff < 0
        indicators['stochrsi_signal'] = np.where(downtrend & (df['StochRSI_K'] < 20) & (df['StochRSI_D'] < 20) &
                                                  (df['StochRSI_K'] > df['StochRSI_D']),
                                                  1,
                                                  np.where(uptrend & (df['StochRSI_K'] > 80) & (df['StochRSI_D'] > 80) &
                                                           (df['StochRSI_K'] < df['StochRSI_D']), -1, 0))
    else:
        indicators['stochrsi_signal'] = 0
    osc_signals_keys.append('stochrsi_signal')

    if 'Williams_%R' in df.columns:
        wr_rising = is_rising(df['Williams_%R'])
        wr_falling = is_falling(df['Williams_%R'])
        indicators['williams_signal'] = np.where(wr_rising & (df['Williams_%R'] < -80), 1,
                                                 np.where(wr_falling & (df['Williams_%R'] > -20), -1, 0))
    else:
        indicators['williams_signal'] = 0
    osc_signals_keys.append('williams_signal')

    if all(x in df.columns for x in ['BullPower', 'BearPower', 'EMA_13']):
        indicators['bulls_bears_signal'] = np.where((df['close'] > df['EMA_13']) & (df['BullPower'] > 0), 1,
                                                    np.where((df['close'] < df['EMA_13']) & (df['BearPower'] < 0), -1, 0))
    else:
        indicators['bulls_bears_signal'] = 0
    osc_signals_keys.append('bulls_bears_signal')

    if 'UO' in df.columns:
        indicators['uo_signal'] = np.where(df['UO'] > 70, 1,
                                           np.where(df['UO'] < 30, -1, 0))
    else:
        indicators['uo_signal'] = 0
    osc_signals_keys.append('uo_signal')

    # Combine into ratings
    ma_df = pd.DataFrame({k: indicators[k] for k in ma_signals_keys}, index=df.index)
    df['ma_rating'] = ma_df.mean(axis=1)
    osc_df = pd.DataFrame({k: indicators[k] for k in osc_signals_keys}, index=df.index)
    weights_map = {'rsi_signal': 2, 'macd_signal': 2}
    weighted_sum = sum(osc_df[col] * weights_map.get(col, 1) for col in osc_signals_keys)
    total_weight = sum(weights_map.get(col, 1) for col in osc_signals_keys)
    df['oscillator_rating'] = weighted_sum / total_weight
    df['tv_tech_rate'] = (df['ma_rating'] + df['oscillator_rating']) / 2
    df['tv_tech_label'] = df['tv_tech_rate'].apply(map_rating)

    if 'volume' in df.columns:
        df['volume_ma20'] = df['volume'].rolling(20).mean()
        df['volume_factor'] = (df['volume'] / df['volume_ma20']).clip(lower=0.5, upper=2.0)
        df['adjusted_tv_tech_rate'] = df['tv_tech_rate'] * df['volume_factor']
    else:
        df['adjusted_tv_tech_rate'] = df['tv_tech_rate']

    indicators_df = pd.DataFrame(indicators, index=df.index)
    df = pd.concat([df, indicators_df], axis=1)
    return df

# ----- DATA FETCHING & RESAMPLING -----
def fetch_ohlcv_1m(exchange, symbol, start_ts, end_ts):
    all_data = []
    limit = 1000
    since_ts = start_ts
    batch_count = 0
    while True:
        data = exchange.fetch_ohlcv(symbol, '1m', since=since_ts, limit=limit)
        if not data:
            break
        all_data.extend(data)
        batch_count += 1
        if batch_count % 100 == 0:  # Log every 100 batches (~100k candles)
            log(f"  [{symbol}] Fetched {len(all_data):,} candles...")
        last_timestamp = data[-1][0]
        if last_timestamp >= end_ts:
            break
        since_ts = last_timestamp + 1
    log(f"  [{symbol}] Total: {len(all_data):,} 1m candles")
    return all_data

def resample_df(df, timeframe):
    # Map timeframe to Pandas offset alias
    rule = {'1m': '1T', '5m': '5T', '15m': '15T', '1h': '1H', '4h': '4H', '1d': '1D'}[timeframe]
    df = df.copy().set_index('timestamp')
    agg = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last', 'volume': 'sum'}
    if timeframe != '1m':
        resampled = df.resample(rule, label='right', closed='right').agg(agg).dropna().reset_index()
        resampled['timestamp'] = resampled['timestamp'] - pd.Timedelta(minutes=1)
    else:
        resampled = df.resample(rule).agg(agg).dropna().reset_index()
    return resampled

# ----- MAIN PROCESSING FUNCTION -----
def process_symbol(exchange, symbol, start_ts, end_ts, timeframes):
    log(f"[{symbol}] Starting - fetching 1m data...")
    data = fetch_ohlcv_1m(exchange, symbol, start_ts, end_ts)
    df_1m = pd.DataFrame(data, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
    df_1m['timestamp'] = pd.to_datetime(df_1m['timestamp'], unit='ms')
    df_1m.sort_values('timestamp', inplace=True)
    df_1m.drop_duplicates(subset=['timestamp'], inplace=True)

    # Calculate indicators and technical ratings on 1m data.
    df_1m = calculate_indicators(df_1m)
    df_1m = calculate_technical_ratings(df_1m)
    merged_df = df_1m.copy().set_index('timestamp')

    # Process each higher timeframe:
    for tf in timeframes:
        if tf == '1m':
            continue
        log(f"  [{symbol}] Processing {tf} timeframe...")
        # Resample using original OHLCV columns from 1m data.
        df_tf = resample_df(df_1m.reset_index()[['timestamp', 'open', 'high', 'low', 'close', 'volume']], tf)
        df_tf = calculate_indicators(df_tf)
        df_tf = calculate_technical_ratings(df_tf)

        # Filter rows: keep only rows where the corresponding bar-close flag is True.
        bar_close_col = f"Bar_Close_{tf}"
        if bar_close_col in df_tf.columns:
            df_tf = df_tf[df_tf[bar_close_col]]

        # Set index on timestamp.
        df_tf.set_index('timestamp', inplace=True)
        # Forward fill the higher timeframe values to all 1m timestamps.
        df_tf = df_tf.reindex(merged_df.index, method='ffill')
        # Add suffix to indicate timeframe.
        df_tf = df_tf.add_suffix(f"_{tf}")

        # Join with the 1m base dataframe.
        merged_df = merged_df.join(df_tf, how='left')

    merged_df.sort_index(inplace=True)
    merged_df.reset_index(inplace=True)

    # Remove base indicator columns (for 1m) that you don't want in the final output.
    cols_to_drop_base = [
        "EMA_13", "BullPower", "BearPower", "CCI_20", "ADX_14", "+DI_14", "-DI_14", "AO",
        "Momentum_10", "STOCHRSI_K", "STOCHRSI_D", "WILLIAMS_%R", "UO", "Ichimoku_lead1",
        "Ichimoku_lead2", "Ichimoku_base", "Ichimoku_conversion", "ma_rating", "oscillator_rating",
        "StochRSI_D", "volume_ma20", "volume_factor", "adjusted_tv_tech_rate",
        "ma_SMA_5", "ma_EMA_5", "ma_SMA_10", "ma_EMA_10", "ma_SMA_14", "ma_EMA_14", "ma_SMA_20",
        "ma_EMA_20", "ma_SMA_25", "ma_EMA_25", "ma_SMA_30", "ma_EMA_30", "ma_SMA_50", "ma_EMA_50",
        "ma_SMA_75", "ma_EMA_75", "ma_SMA_100", "ma_EMA_100", "ma_SMA_150", "ma_EMA_150",
        "ma_SMA_200", "ma_EMA_200", "ma_SMA_250", "ma_EMA_250", "ma_EMA_13", "Ichimoku_signal",
        "rsi_signal", "stochastic_signal", "cci_signal", "adx_signal", "ao_signal", "momentum_signal",
        "macd_signal", "stochrsi_signal", "williams_signal", "bulls_bears_signal", "uo_signal",
        "StochRSI_K", "Williams_", "ichimoku_signal",
        "Bar_Close_1m_5m", "Bar_Close_5m_5m", "Bar_Close_15m_5m", "Bar_Close_1h_5m", "Bar_Close_4h_5m", "Bar_Close_1d_5m",
        "Bar_Close_1m_15m", "Bar_Close_5m_15m", "Bar_Close_15m_15m", "Bar_Close_1h_15m", "Bar_Close_4h_15m", "Bar_Close_1d_15m",
        "Bar_Close_1m_1h", "Bar_Close_5m_1h", "Bar_Close_15m_1h", "Bar_Close_1h_1h", "Bar_Close_4h_1h", "Bar_Close_1d_1h",
        "Bar_Close_1m_4h", "Bar_Close_5m_4h", "Bar_Close_15m_4h", "Bar_Close_1h_4h", "Bar_Close_4h_4h", "Bar_Close_1d_4h",
        "Bar_Close_1m_1d", "Bar_Close_5m_1d", "Bar_Close_15m_1d", "Bar_Close_1h_1d", "Bar_Close_4h_1d", "Bar_Close_1d_1d"
    ]
    cols_to_drop = cols_to_drop_base.copy()  # base names (1m)
    for tf in timeframes:
        if tf == '1m':
            continue
        for col in cols_to_drop_base:
            cols_to_drop.append(f"{col}_{tf}")

    merged_df = merged_df.drop(columns=cols_to_drop, errors='ignore')

    import os
    os.makedirs("static", exist_ok=True)
    file_name = f"static/{symbol.replace('/', '_')}_all_tf_merged.parquet"
    merged_df.to_parquet(file_name, index=False, compression='snappy')
    log(f"✓ [{symbol}] SAVED: {file_name} (shape: {merged_df.shape})")

# ----- MAIN SCRIPT -----
if __name__ == "__main__":
    log("=" * 60)
    log("ALGOTCHA DATA FETCHER - 5 Years 1-Minute Data")
    log("=" * 60)
    exchange = ccxt.binance({'enableRateLimit': True})
    symbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "ADA/USDT",
    "DOGE/USDT", "AVAX/USDT", "LINK/USDT", "DOT/USDT", "NEAR/USDT",
    "LTC/USDT", "HBAR/USDT", "SUI/USDT", "TRX/USDT", "BCH/USDT",
    "RENDER/USDT", "ATOM/USDT"]
    start_date = '2020-01-01T00:00:00Z'  # 5 years of data
    end_date = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    start_ts = exchange.parse8601(start_date)
    end_ts = exchange.parse8601(end_date)
    timeframes = ['1m', '5m', '15m', '1h', '4h', '1d']

    # Reduced to 2 workers to prevent memory issues during indicator calculation
    # Each symbol with indicators can use 2-4GB RAM
    max_workers = 2
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(process_symbol, exchange, symbol, start_ts, end_ts, timeframes): symbol for symbol in symbols}
        for future in as_completed(futures):
            sym = futures[future]
            try:
                future.result()
                log(f"✓✓✓ COMPLETED: {sym}")
            except Exception as e:
                log(f"❌ ERROR {sym}: {e}")
