#!/usr/bin/env python3
"""
Live Trading Signal Generator
Uses the EXACT same logic as backtest.py to generate entry/exit signals.
This ensures live trading mirrors backtest behavior 100%.
"""
import sys
import os
import json
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta
import ccxt

# Add scripts directory to path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

# Import from backtest - same indicator calculations
DATA_DIR = os.path.join(SCRIPT_DIR, '..', 'static')

TIMEFRAME_TO_MINUTES = {
    "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60,
    "2h": 120, "4h": 240, "1d": 1440
}


def calculate_rsi(closes: pd.Series, period: int = 14) -> float:
    """Calculate RSI - same as backtest"""
    if len(closes) < period + 1:
        return 50.0  # Neutral if not enough data
    
    delta = closes.diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    
    rs = gain / (loss + 1e-10)
    rsi = 100 - (100 / (1 + rs))
    return float(rsi.iloc[-1])


def calculate_sma(closes: pd.Series, period: int) -> float:
    """Calculate SMA - same as backtest"""
    if len(closes) < period:
        return float(closes.iloc[-1])
    return float(closes.rolling(window=period).mean().iloc[-1])


def calculate_ema(closes: pd.Series, period: int) -> float:
    """Calculate EMA - same as backtest"""
    if len(closes) < period:
        return float(closes.iloc[-1])
    return float(closes.ewm(span=period, adjust=False).mean().iloc[-1])


def calculate_bb_percent_b(closes: pd.Series, period: int = 20, dev: float = 2.0) -> float:
    """Calculate Bollinger Bands %B - same as backtest"""
    if len(closes) < period:
        return 0.5  # Neutral if not enough data
    
    sma = closes.rolling(window=period).mean()
    std = closes.rolling(window=period).std()
    
    upper = sma + (std * dev)
    lower = sma - (std * dev)
    
    # %B = (Close - Lower) / (Upper - Lower)
    percent_b = (closes - lower) / (upper - lower + 1e-10)
    return float(percent_b.iloc[-1])


def calculate_macd(closes: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    """Calculate MACD - same as backtest"""
    if len(closes) < slow + signal:
        return {'line': 0, 'signal': 0, 'hist': 0}
    
    ema_fast = closes.ewm(span=fast, adjust=False).mean()
    ema_slow = closes.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    
    return {
        'line': float(macd_line.iloc[-1]),
        'signal': float(signal_line.iloc[-1]),
        'hist': float(histogram.iloc[-1])
    }


def fetch_ohlcv(exchange: ccxt.Exchange, symbol: str, timeframe: str, limit: int = 500) -> pd.DataFrame:
    """Fetch OHLCV data from exchange"""
    try:
        ohlcv = exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
        df = pd.DataFrame(ohlcv, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
        df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')
        return df
    except Exception as e:
        print(f"Error fetching {symbol} {timeframe}: {e}", file=sys.stderr)
        return pd.DataFrame()


def get_indicator_value(df: pd.DataFrame, indicator: str, subfields: dict) -> dict:
    """
    Get indicator value - mirrors backtest logic exactly.
    Returns current and previous values for crossing detection.
    """
    if df.empty or len(df) < 2:
        return {'current': None, 'previous': None}
    
    closes = df['close']
    
    if indicator == 'RSI':
        period = subfields.get('RSI Length', 14)
        current = calculate_rsi(closes, period)
        previous = calculate_rsi(closes.iloc[:-1], period) if len(closes) > period + 1 else current
        return {'current': current, 'previous': previous}
    
    elif indicator == 'MA':
        ma_type = subfields.get('MA Type', 'SMA')
        fast_period = subfields.get('Fast MA', 50)
        slow_period = subfields.get('Slow MA', 200)
        
        if ma_type == 'EMA':
            fast_current = calculate_ema(closes, fast_period)
            slow_current = calculate_ema(closes, slow_period)
            fast_prev = calculate_ema(closes.iloc[:-1], fast_period) if len(closes) > slow_period else fast_current
            slow_prev = calculate_ema(closes.iloc[:-1], slow_period) if len(closes) > slow_period else slow_current
        else:
            fast_current = calculate_sma(closes, fast_period)
            slow_current = calculate_sma(closes, slow_period)
            fast_prev = calculate_sma(closes.iloc[:-1], fast_period) if len(closes) > slow_period else fast_current
            slow_prev = calculate_sma(closes.iloc[:-1], slow_period) if len(closes) > slow_period else slow_current
        
        return {
            'current': fast_current,
            'compare': slow_current,
            'previous': fast_prev,
            'compare_prev': slow_prev
        }
    
    elif indicator == 'BollingerBands':
        period = subfields.get('BB% Period', 20)
        dev = subfields.get('Deviation', 2)
        current = calculate_bb_percent_b(closes, period, dev)
        previous = calculate_bb_percent_b(closes.iloc[:-1], period, dev) if len(closes) > period else current
        return {'current': current, 'previous': previous}
    
    elif indicator == 'MACD':
        preset = subfields.get('MACD Preset', '12,26,9')
        fast, slow, signal = map(int, preset.split(','))
        macd = calculate_macd(closes, fast, slow, signal)
        macd_prev = calculate_macd(closes.iloc[:-1], fast, slow, signal) if len(closes) > slow + signal else macd
        return {
            'current': macd['line'],
            'compare': macd['signal'],
            'previous': macd_prev['line'],
            'compare_prev': macd_prev['signal']
        }
    
    return {'current': None, 'previous': None}


def check_condition(indicator_values: dict, condition: str, target_value: float, indicator: str) -> bool:
    """
    Check if a condition is met - mirrors backtest logic exactly.
    """
    current = indicator_values.get('current')
    previous = indicator_values.get('previous')
    compare = indicator_values.get('compare')
    compare_prev = indicator_values.get('compare_prev')
    
    if current is None:
        return False
    
    # For MA and MACD, compare fast to slow/signal
    if indicator in ['MA', 'MACD'] and compare is not None:
        if condition == 'Less Than':
            return current < compare
        elif condition == 'Greater Than':
            return current > compare
        elif condition == 'Crossing Up':
            if previous is None or compare_prev is None:
                return False
            return previous <= compare_prev and current > compare
        elif condition == 'Crossing Down':
            if previous is None or compare_prev is None:
                return False
            return previous >= compare_prev and current < compare
    else:
        # For RSI and BB, compare to target value
        if condition == 'Less Than':
            return current < target_value
        elif condition == 'Greater Than':
            return current > target_value
        elif condition == 'Crossing Up':
            if previous is None:
                return False
            return previous <= target_value and current > target_value
        elif condition == 'Crossing Down':
            if previous is None:
                return False
            return previous >= target_value and current < target_value
    
    return False


def check_conditions(exchange: ccxt.Exchange, symbol: str, conditions: list) -> dict:
    """
    Check all conditions for a symbol.
    Returns whether all conditions are met and indicator values.
    """
    if not conditions:
        return {'met': False, 'indicators': {}}
    
    indicators = {}
    all_met = True
    
    for cond in conditions:
        indicator = cond.get('indicator', '')
        subfields = cond.get('subfields', {})
        timeframe = subfields.get('Timeframe', '1m')
        condition_type = subfields.get('Condition', 'Greater Than')
        target_value = subfields.get('Signal Value', 0)
        
        # Skip special indicators
        if indicator in ['IMMEDIATE', 'TIME_ELAPSED']:
            continue
        
        # Fetch data for this timeframe
        df = fetch_ohlcv(exchange, symbol, timeframe, limit=300)
        
        if df.empty:
            all_met = False
            continue
        
        # Get indicator values
        values = get_indicator_value(df, indicator, subfields)
        indicators[f"{indicator}_{timeframe}"] = values
        
        # Check condition
        if not check_condition(values, condition_type, target_value, indicator):
            all_met = False
    
    return {'met': all_met, 'indicators': indicators}


def generate_signal(config: dict) -> dict:
    """
    Generate trading signal based on strategy config.
    This mirrors the backtest logic exactly.
    """
    # Parse config
    exchange_id = config.get('exchange', 'binance')
    api_key = config.get('api_key', '')
    api_secret = config.get('api_secret', '')
    symbol = config.get('symbol', 'BTC/USDT')
    entry_conditions = config.get('entry_conditions', [])
    exit_conditions = config.get('exit_conditions', [])
    has_position = config.get('has_position', False)
    position_entry_time = config.get('position_entry_time')
    
    # Initialize exchange
    exchange_class = getattr(ccxt, exchange_id, ccxt.binance)
    exchange = exchange_class({
        'apiKey': api_key,
        'secret': api_secret,
        'enableRateLimit': True,
    })
    
    result = {
        'symbol': symbol,
        'signal': 'HOLD',
        'indicators': {},
        'reason': '',
        'timestamp': datetime.now(timezone.utc).isoformat()
    }
    
    try:
        if not has_position:
            # Check entry conditions
            entry_check = check_conditions(exchange, symbol, entry_conditions)
            result['indicators'] = entry_check['indicators']
            
            if entry_check['met']:
                result['signal'] = 'BUY'
                result['reason'] = 'All entry conditions met'
        else:
            # Check exit conditions
            # Handle TIME_ELAPSED specially
            time_elapsed_cond = next(
                (c for c in exit_conditions if c.get('indicator') == 'TIME_ELAPSED'),
                None
            )
            
            if time_elapsed_cond and position_entry_time:
                minutes_required = time_elapsed_cond.get('subfields', {}).get('minutes', 5)
                entry_time = datetime.fromisoformat(position_entry_time.replace('Z', '+00:00'))
                minutes_elapsed = (datetime.now(timezone.utc) - entry_time).total_seconds() / 60
                
                if minutes_elapsed >= minutes_required:
                    result['signal'] = 'SELL'
                    result['reason'] = f'Time elapsed ({minutes_elapsed:.1f}m >= {minutes_required}m)'
                    return result
            
            # Check other exit conditions
            exit_check = check_conditions(exchange, symbol, exit_conditions)
            result['indicators'].update(exit_check['indicators'])
            
            if exit_check['met']:
                result['signal'] = 'SELL'
                result['reason'] = 'All exit conditions met'
    
    except Exception as e:
        result['error'] = str(e)
    
    return result


if __name__ == '__main__':
    # Read config from stdin or args
    if len(sys.argv) > 1:
        config = json.loads(sys.argv[1])
    else:
        config = json.load(sys.stdin)
    
    signal = generate_signal(config)
    print(json.dumps(signal))

