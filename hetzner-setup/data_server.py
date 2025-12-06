#!/usr/bin/env python3
"""
Algotcha Data Server
Serves parquet data via HTTP API for Railway backend
Includes full backtesting capabilities with caching and job queue
"""
import os
import sys
import json
import subprocess
import tempfile
import hashlib
import uuid
from datetime import datetime
from flask import Flask, jsonify, request
import pandas as pd

# Add scripts directory to path for imports
sys.path.insert(0, '/opt/algotcha/scripts')

app = Flask(__name__)

DATA_DIR = '/opt/algotcha/data'
SCRIPTS_DIR = '/opt/algotcha/scripts'
RESULTS_DIR = '/opt/algotcha/backtest_results'
API_KEY = os.environ.get('ALGOTCHA_API_KEY', 'your-secret-key-here')
REDIS_URL = os.environ.get('REDIS_URL', 'redis://localhost:6379')

# Ensure results directory exists
os.makedirs(RESULTS_DIR, exist_ok=True)

# Try to connect to Redis for caching
try:
    import redis
    redis_client = redis.from_url(REDIS_URL)
    redis_client.ping()
    REDIS_AVAILABLE = True
    print("✅ Redis connected for caching")
except:
    redis_client = None
    REDIS_AVAILABLE = False
    print("⚠️ Redis not available, running without cache")

# In-memory cache fallback (for single-worker mode)
MEMORY_CACHE = {}
CACHE_TTL = 3600 * 6  # 6 hours


def get_cache_key(config: dict) -> str:
    """Generate cache key from backtest config"""
    normalized = json.dumps(config, sort_keys=True)
    return f"backtest:{hashlib.sha256(normalized.encode()).hexdigest()[:16]}"


def get_cached(key: str):
    """Get from cache (Redis or memory)"""
    if REDIS_AVAILABLE:
        cached = redis_client.get(key)
        if cached:
            return json.loads(cached)
    elif key in MEMORY_CACHE:
        entry = MEMORY_CACHE[key]
        if datetime.utcnow().timestamp() < entry['expires']:
            return entry['data']
        else:
            del MEMORY_CACHE[key]
    return None


def set_cached(key: str, data: dict, ttl: int = CACHE_TTL):
    """Set in cache (Redis or memory)"""
    if REDIS_AVAILABLE:
        redis_client.setex(key, ttl, json.dumps(data))
    else:
        MEMORY_CACHE[key] = {
            'data': data,
            'expires': datetime.utcnow().timestamp() + ttl
        }
        # Limit memory cache size
        if len(MEMORY_CACHE) > 100:
            oldest = min(MEMORY_CACHE.keys(), key=lambda k: MEMORY_CACHE[k]['expires'])
            del MEMORY_CACHE[oldest]

def check_auth():
    """Check API key authentication"""
    key = request.headers.get('X-API-Key')
    if key != API_KEY:
        return False
    return True

@app.route('/health')
def health():
    return jsonify({'status': 'healthy', 'timestamp': datetime.utcnow().isoformat()})


@app.route('/data/date-range')
def get_date_range():
    """Get available data date range for validation"""
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401
    
    try:
        # Check BTC as reference (most complete data)
        df = pd.read_parquet(
            os.path.join(DATA_DIR, 'BTC_USDT_all_tf_merged.parquet'),
            columns=['timestamp']
        )
        first_date = df['timestamp'].min()
        last_date = df['timestamp'].max()
        
        return jsonify({
            'firstDate': str(first_date)[:10],  # YYYY-MM-DD
            'lastDate': str(last_date)[:10],
            'lastTimestamp': str(last_date),
            'totalRows': len(df),
            'availableYears': list(range(first_date.year, last_date.year + 1))
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/data/status')
def data_status():
    """Return status of available data files"""
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401
    
    files = []
    if os.path.exists(DATA_DIR):
        for f in os.listdir(DATA_DIR):
            if f.endswith('.parquet'):
                path = os.path.join(DATA_DIR, f)
                stat = os.stat(path)
                files.append({
                    'name': f,
                    'size_mb': round(stat.st_size / 1024 / 1024, 2),
                    'modified': datetime.fromtimestamp(stat.st_mtime).isoformat()
                })
    
    return jsonify({
        'hasData': len(files) > 0,
        'fileCount': len(files),
        'files': sorted(files, key=lambda x: x['name'])
    })

@app.route('/data/latest/<symbol>')
def get_latest(symbol):
    """Get latest data row for a symbol. Use underscore format: BTC_USDT"""
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401
    
    # Map symbol to filename - expect BTC_USDT format
    clean_symbol = symbol.upper().replace('/', '_')
    if not clean_symbol.endswith('_USDT') and 'USDT' in clean_symbol:
        clean_symbol = clean_symbol.replace('USDT', '_USDT')
    filename = f"{clean_symbol}_all_tf_merged.parquet"
    filepath = os.path.join(DATA_DIR, filename)
    
    if not os.path.exists(filepath):
        return jsonify({'error': f'Data not found for {symbol}'}), 404
    
    try:
        df = pd.read_parquet(filepath)
        latest = df.iloc[-1].to_dict()
        
        # Convert any numpy types to Python types
        for k, v in latest.items():
            if hasattr(v, 'item'):
                latest[k] = v.item()
            elif pd.isna(v):
                latest[k] = None
        
        return jsonify({
            'symbol': symbol,
            'timestamp': str(latest.get('timestamp', '')),
            'data': latest
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/data/range/<symbol>')
def get_range(symbol):
    """Get data range for a symbol. Use underscore format: BTC_USDT"""
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401
    
    limit = request.args.get('limit', 100, type=int)
    
    # Map symbol to filename - expect BTC_USDT format
    clean_symbol = symbol.upper().replace('/', '_')
    if not clean_symbol.endswith('_USDT') and 'USDT' in clean_symbol:
        clean_symbol = clean_symbol.replace('USDT', '_USDT')
    filename = f"{clean_symbol}_all_tf_merged.parquet"
    filepath = os.path.join(DATA_DIR, filename)
    
    if not os.path.exists(filepath):
        return jsonify({'error': f'Data not found for {symbol}'}), 404
    
    try:
        df = pd.read_parquet(filepath)
        data = df.tail(limit).to_dict('records')
        
        # Convert types
        for row in data:
            for k, v in row.items():
                if hasattr(v, 'item'):
                    row[k] = v.item()
                elif pd.isna(v):
                    row[k] = None
        
        return jsonify({
            'symbol': symbol,
            'count': len(data),
            'data': data
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/signal/check', methods=['POST'])
def check_signal():
    """Check if a strategy signal is triggered based on latest data"""
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401
    
    body = request.json
    symbol = body.get('symbol')
    conditions = body.get('conditions', [])
    
    # Map symbol to filename
    clean_symbol = symbol.replace('/', '_').replace('%2F', '_').upper()
    if '_' not in clean_symbol:
        clean_symbol = clean_symbol.replace('USDT', '_USDT')
    filename = f"{clean_symbol}_all_tf_merged.parquet"
    filepath = os.path.join(DATA_DIR, filename)
    
    if not os.path.exists(filepath):
        return jsonify({'error': f'Data not found for {symbol}'}), 404
    
    try:
        df = pd.read_parquet(filepath)
        latest = df.iloc[-1]
        prev = df.iloc[-2] if len(df) > 1 else latest
        
        results = []
        all_met = True
        
        for cond in conditions:
            indicator = cond.get('indicator')
            operator = cond.get('operator')
            value = cond.get('value')
            
            # Get indicator value from latest data
            indicator_value = latest.get(indicator, None)
            prev_value = prev.get(indicator, None)
            
            if indicator_value is None:
                results.append({
                    'indicator': indicator,
                    'met': False,
                    'reason': f'{indicator} not found in data'
                })
                all_met = False
                continue
            
            met = False
            if operator == 'GreaterThan':
                met = float(indicator_value) > float(value)
            elif operator == 'LessThan':
                met = float(indicator_value) < float(value)
            elif operator == 'CrossingUp':
                met = float(prev_value) < float(value) and float(indicator_value) >= float(value)
            elif operator == 'CrossingDown':
                met = float(prev_value) > float(value) and float(indicator_value) <= float(value)
            
            results.append({
                'indicator': indicator,
                'value': float(indicator_value) if indicator_value else None,
                'threshold': value,
                'operator': operator,
                'met': met
            })
            
            if not met:
                all_met = False
        
        return jsonify({
            'symbol': symbol,
            'signalTriggered': all_met,
            'timestamp': str(latest.get('timestamp', '')),
            'price': float(latest.get('close', 0)),
            'conditions': results
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/backtest/run', methods=['POST'])
def run_backtest():
    """Run a full backtest using backtest2.py"""
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401
    
    body = request.json
    if not body:
        return jsonify({'error': 'No request body'}), 400
    
    start_time = datetime.utcnow()
    
    # Build the backtest payload
    payload = {
        'strategy_name': body.get('strategy_name', 'API Backtest'),
        'pairs': body.get('pairs', ['BTC/USDT']),
        'max_active_deals': body.get('max_active_deals', 3),
        'trading_fee': body.get('trading_fee', 0.001),
        'base_order_size': body.get('base_order_size', 1000.0),
        'initial_balance': body.get('initial_balance', 10000.0),
        'start_date': body.get('start_date', '2024-01-01'),
        'end_date': body.get('end_date', '2024-12-31'),
        'entry_conditions': body.get('entry_conditions', []),
        'exit_conditions': body.get('exit_conditions', []),
        'conditions_active': body.get('conditions_active', True),
        'price_change_active': body.get('price_change_active', False),
        'target_profit': body.get('target_profit', 0.0),
        'stop_loss_toggle': body.get('stop_loss_toggle', False),
        'stop_loss_value': body.get('stop_loss_value', 0.0),
        'cooldown_between_deals': body.get('cooldown_between_deals', 0),
        'safety_order_toggle': False,
        'reinvest_profit': 0.0,
        'risk_reduction': 0.0,
        'min_daily_volume': 0.0
    }
    
    try:
        # Import and run backtest directly
        import backtest2
        
        # Override DATA_DIR in backtest2
        backtest2.DATA_DIR = DATA_DIR
        
        # Run the backtest
        result = backtest2.run_backtest(payload)
        
        run_time = (datetime.utcnow() - start_time).total_seconds()
        
        if result.get('status') == 'success':
            metrics = result.get('metrics', {})
            return jsonify({
                'status': 'success',
                'runTime': run_time,
                'metrics': {
                    'net_profit': round(metrics.get('net_profit', 0) * 100, 2),  # Convert to percentage
                    'net_profit_usd': metrics.get('net_profit_usd', '$0'),
                    'total_profit': round(metrics.get('total_profit', 0) * 100, 2),
                    'total_profit_usd': metrics.get('total_profit_usd', '$0'),
                    'max_drawdown': round(metrics.get('max_drawdown', 0) * 100, 2),
                    'max_realized_drawdown': round(metrics.get('max_realized_drawdown', 0) * 100, 2),
                    'sharpe_ratio': round(metrics.get('sharpe_ratio', 0), 2),
                    'sortino_ratio': round(metrics.get('sortino_ratio', 0), 2),
                    'win_rate': round(metrics.get('win_rate', 0), 2),
                    'total_trades': metrics.get('total_trades', 0),
                    'profit_factor': metrics.get('profit_factor', 0),
                    'avg_profit_per_trade': round(metrics.get('avg_profit_per_trade', 0), 2),
                    'yearly_return': round(metrics.get('yearly_return', 0) * 100, 2),
                    'exposure_time_frac': round(metrics.get('exposure_time_frac', 0), 2),
                },
                'chartData': result.get('chartData', {}),
                'totalTrades': result.get('totalTrades', 0)
            })
        else:
            return jsonify({
                'status': 'error',
                'error': result.get('message', 'Backtest failed'),
                'runTime': run_time
            })
            
    except Exception as e:
        import traceback
        return jsonify({
            'status': 'error', 
            'error': str(e),
            'traceback': traceback.format_exc(),
            'runTime': (datetime.utcnow() - start_time).total_seconds()
        }), 500


@app.route('/backtest/preset/<strategy_id>', methods=['POST'])
def run_preset_backtest(strategy_id):
    """Run backtest for a preset strategy with custom dates - WITH CACHING"""
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401
    
    body = request.json or {}
    start_time = datetime.utcnow()
    
    # Preset strategy configurations
    # Only long strategy - short removed per user request
    PRESET_STRATEGIES = {
        'rsi-ma-bb-long': {
            'strategy_name': 'RSI + MA + BB Long Strategy',
            'direction': 'long',
            'entry_conditions': [
                {'indicator': 'RSI', 'subfields': {'RSI Length': 28, 'Timeframe': '15m', 'Condition': 'Greater Than', 'Signal Value': 70}},
                {'indicator': 'MA', 'subfields': {'MA Type': 'SMA', 'Fast MA': 50, 'Slow MA': 200, 'Condition': 'Greater Than', 'Timeframe': '1h'}}
            ],
            'exit_conditions': [
                {'indicator': 'BollingerBands', 'subfields': {'BB% Period': 20, 'Deviation': 1, 'Condition': 'Less Than', 'Timeframe': '4h', 'Signal Value': 0.1}}
            ],
            # Available pairs with complete data
            'pairs': ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'ADA/USDT', 'DOGE/USDT', 'AVAX/USDT', 'DOT/USDT', 'LINK/USDT', 'LTC/USDT', 'NEAR/USDT', 'HBAR/USDT', 'TRX/USDT']
        }
    }
    
    if strategy_id not in PRESET_STRATEGIES:
        return jsonify({'error': f'Unknown strategy: {strategy_id}'}), 404
    
    preset = PRESET_STRATEGIES[strategy_id]
    
    # Get date range to determine memory constraints
    start_date = body.get('start_date', '2024-01-01')
    end_date = body.get('end_date', '2025-04-01')
    
    # Calculate period length in years
    from datetime import datetime
    try:
        start_dt = datetime.strptime(start_date, '%Y-%m-%d')
        end_dt = datetime.strptime(end_date, '%Y-%m-%d')
        period_years = (end_dt - start_dt).days / 365.0
    except:
        period_years = 1.0
    
    # Limit pairs based on period length (memory constraints)
    # - Long periods (>3 years): max 2 pairs
    # - Medium periods (1-3 years): max 5 pairs
    # - Short periods (<1 year): max 5 pairs
    if period_years > 3:
        max_pairs = 2
    else:
        max_pairs = 5
    
    # Apply user-requested pairs with limit
    requested_pairs = body.get('pairs', preset['pairs'][:max_pairs])
    if len(requested_pairs) > max_pairs:
        requested_pairs = requested_pairs[:max_pairs]
    
    # Max active deals = number of pairs chosen (user constraint)
    num_pairs = len(requested_pairs)
    max_active_deals = min(body.get('max_active_deals', num_pairs), num_pairs)
    
    # Build cache key from request params
    cache_config = {
        'strategy_id': strategy_id,
        'pairs': sorted(requested_pairs),
        'start_date': start_date,
        'end_date': end_date,
        'initial_balance': body.get('initial_balance', 10000.0)
    }
    cache_key = get_cache_key(cache_config)
    
    # Check cache first
    cached = get_cached(cache_key)
    if cached:
        cached['cached'] = True
        cached['runTime'] = 0.01
        return jsonify(cached)
    
    # Build payload with custom dates
    # IMPORTANT: These settings match the original validated backtest
    payload = {
        'strategy_name': preset['strategy_name'],
        'pairs': requested_pairs,
        'max_active_deals': max_active_deals,
        'trading_fee': 0.1,  # 0.1% (backtest divides by 100)
        'base_order_size': 1000.0,
        'initial_balance': body.get('initial_balance', 10000.0),
        'start_date': start_date,
        'end_date': end_date,
        'entry_conditions': preset['entry_conditions'],
        'exit_conditions': preset['exit_conditions'],
        'conditions_active': True,
        'price_change_active': False,
        'target_profit': 0.0,
        'stop_loss_toggle': False,
        'stop_loss_value': 0.0,
        'cooldown_between_deals': 0,
        'safety_order_toggle': False,
        'reinvest_profit': 100.0,  # 100% reinvestment for compounding
        'risk_reduction': 100.0,
        'min_daily_volume': 0.0
    }
    
    try:
        import backtest2
        backtest2.DATA_DIR = DATA_DIR
        result = backtest2.run_backtest(payload)
        
        run_time = (datetime.utcnow() - start_time).total_seconds()
        
        if result.get('status') == 'success':
            metrics = result.get('metrics', {})
            
            # Extract trades from df_out if available
            trades = []
            df_out = result.get('df_out', [])
            if df_out:
                # Filter to only BUY/SELL actions
                for row in df_out[:500]:  # Limit to 500 trades
                    if isinstance(row, dict) and row.get('action') in ['BUY', 'SELL']:
                        trades.append({
                            'timestamp': str(row.get('timestamp', '')),
                            'symbol': row.get('symbol', ''),
                            'action': row.get('action', ''),
                            'price': row.get('price', 0),
                            'order_size': row.get('order_size', 0),
                            'profit_loss': row.get('profit_loss', 0),
                            'balance': row.get('balance', 0),
                            'trade_comment': row.get('trade_comment', '')
                        })
            
            # Extract chart data
            chart_data = result.get('chartData', {})
            balance_history = []
            if chart_data:
                timestamps = chart_data.get('timestamps', [])
                balances = chart_data.get('unrealized_balance', [])
                # Sample to reduce size
                step = max(1, len(timestamps) // 100)
                for i in range(0, len(timestamps), step):
                    if i < len(balances):
                        balance_history.append({
                            'date': timestamps[i][:10] if len(timestamps[i]) > 10 else timestamps[i],
                            'balance': balances[i]
                        })
            
            response_data = {
                'status': 'success',
                'runTime': run_time,
                'cached': False,
                'strategyId': strategy_id,
                'pairsUsed': len(requested_pairs),
                'metrics': {
                    'net_profit': round(metrics.get('net_profit', 0) * 100, 2),
                    'net_profit_usd': metrics.get('net_profit_usd', '$0'),
                    'total_profit': round(metrics.get('total_profit', 0) * 100, 2),
                    'total_profit_usd': metrics.get('total_profit_usd', '$0'),
                    'max_drawdown': round(metrics.get('max_drawdown', 0) * 100, 2),
                    'max_realized_drawdown': round(metrics.get('max_realized_drawdown', 0) * 100, 2),
                    'sharpe_ratio': round(metrics.get('sharpe_ratio', 0), 2),
                    'sortino_ratio': round(metrics.get('sortino_ratio', 0), 2),
                    'win_rate': round(metrics.get('win_rate', 0), 2),
                    'total_trades': metrics.get('total_trades', 0),
                    'profit_factor': metrics.get('profit_factor', 0),
                    'avg_profit_per_trade': round(metrics.get('avg_profit_per_trade', 0), 2),
                    'yearly_return': round(metrics.get('yearly_return', 0) * 100, 2),
                    'exposure_time_frac': round(metrics.get('exposure_time_frac', 0), 2),
                },
                'trades': trades[:100],  # Return first 100 trades
                'totalTrades': len(trades),
                'chartData': {
                    'balanceHistory': balance_history
                }
            }
            
            # Cache the result (without full trades to save space)
            cache_data = {**response_data, 'trades': trades[:20]}
            set_cached(cache_key, cache_data)
            
            return jsonify(response_data)
        else:
            return jsonify({
                'status': 'error',
                'error': result.get('message', 'Backtest failed'),
                'runTime': run_time
            })
            
    except Exception as e:
        import traceback
        return jsonify({
            'status': 'error',
            'error': str(e),
            'traceback': traceback.format_exc(),
            'runTime': (datetime.utcnow() - start_time).total_seconds()
        }), 500


# ============================================
# CONTINUOUS STRATEGY RESULTS API
# ============================================

import sqlite3

DB_FILE = '/opt/algotcha/data/strategy_results.db'

@app.route('/strategy/results/<strategy_id>')
def get_strategy_results(strategy_id):
    """Get strategy results for any period - instant from database"""
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401
    
    start_date = request.args.get('start_date', '2020-01-01')
    end_date = request.args.get('end_date', datetime.utcnow().strftime('%Y-%m-%d'))
    limit = request.args.get('limit', 1000, type=int)
    
    try:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        # Get trades
        cursor.execute('''
            SELECT * FROM trades 
            WHERE strategy_id = ? AND timestamp BETWEEN ? AND ?
            ORDER BY timestamp DESC
            LIMIT ?
        ''', (strategy_id, start_date, end_date, limit))
        trades = [dict(row) for row in cursor.fetchall()]
        
        # Get current state
        cursor.execute('SELECT * FROM strategy_state WHERE strategy_id = ?', (strategy_id,))
        state_row = cursor.fetchone()
        state = dict(state_row) if state_row else {}
        
        # Get metrics history for chart
        cursor.execute('''
            SELECT timestamp, balance, drawdown FROM metrics_history
            WHERE strategy_id = ? AND timestamp BETWEEN ? AND ?
            ORDER BY timestamp
        ''', (strategy_id, start_date, end_date))
        metrics = [dict(row) for row in cursor.fetchall()]
        
        # Calculate summary metrics
        cursor.execute('''
            SELECT 
                COUNT(*) as total_trades,
                SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(profit_loss) as total_profit,
                AVG(profit_loss) as avg_profit,
                MAX(profit_loss) as max_profit,
                MIN(profit_loss) as max_loss
            FROM trades
            WHERE strategy_id = ? AND timestamp BETWEEN ? AND ? AND action = 'SELL'
        ''', (strategy_id, start_date, end_date))
        summary_row = cursor.fetchone()
        summary = dict(summary_row) if summary_row else {}
        
        conn.close()
        
        # Calculate win rate
        total = summary.get('total_trades', 0) or 0
        winning = summary.get('winning_trades', 0) or 0
        win_rate = (winning / total * 100) if total > 0 else 0
        
        return jsonify({
            'strategy_id': strategy_id,
            'period': {'start': start_date, 'end': end_date},
            'state': {
                'balance': state.get('balance', 10000),
                'active_deals': state.get('active_deals', 0),
                'total_profit': state.get('total_profit', 0),
                'positions': json.loads(state.get('positions', '{}')) if state.get('positions') else {}
            },
            'summary': {
                'total_trades': total,
                'winning_trades': winning,
                'win_rate': round(win_rate, 2),
                'total_profit': round(summary.get('total_profit', 0) or 0, 2),
                'avg_profit': round(summary.get('avg_profit', 0) or 0, 2),
                'max_profit': round(summary.get('max_profit', 0) or 0, 2),
                'max_loss': round(summary.get('max_loss', 0) or 0, 2)
            },
            'trades': trades,
            'chartData': {
                'balanceHistory': [{'date': m['timestamp'][:10], 'balance': m['balance']} for m in metrics[-200:]]
            }
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/strategy/state/<strategy_id>')
def get_strategy_state(strategy_id):
    """Get current strategy state"""
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401
    
    try:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        cursor.execute('SELECT * FROM strategy_state WHERE strategy_id = ?', (strategy_id,))
        row = cursor.fetchone()
        conn.close()
        
        if not row:
            return jsonify({'error': 'Strategy not found'}), 404
        
        state = dict(row)
        state['positions'] = json.loads(state.get('positions', '{}')) if state.get('positions') else {}
        
        return jsonify(state)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/strategy/latest-trades/<strategy_id>')
def get_latest_trades(strategy_id):
    """Get latest trades for a strategy"""
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401
    
    limit = request.args.get('limit', 50, type=int)
    
    try:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT * FROM trades 
            WHERE strategy_id = ?
            ORDER BY timestamp DESC
            LIMIT ?
        ''', (strategy_id, limit))
        trades = [dict(row) for row in cursor.fetchall()]
        conn.close()
        
        return jsonify({
            'strategy_id': strategy_id,
            'trades': trades,
            'count': len(trades)
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"🚀 Algotcha Data Server starting on port {port}")
    print(f"📁 Data directory: {DATA_DIR}")
    print(f"📜 Scripts directory: {SCRIPTS_DIR}")
    app.run(host='0.0.0.0', port=port)

