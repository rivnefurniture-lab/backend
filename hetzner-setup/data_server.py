#!/usr/bin/env python3
"""
Algotcha Data Server
Serves parquet data via HTTP API for Railway backend
Includes full backtesting capabilities
"""
import os
import sys
import json
import subprocess
import tempfile
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

# Ensure results directory exists
os.makedirs(RESULTS_DIR, exist_ok=True)

def check_auth():
    """Check API key authentication"""
    key = request.headers.get('X-API-Key')
    if key != API_KEY:
        return False
    return True

@app.route('/health')
def health():
    return jsonify({'status': 'healthy', 'timestamp': datetime.utcnow().isoformat()})

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
    """Run backtest for a preset strategy with custom dates"""
    if not check_auth():
        return jsonify({'error': 'Unauthorized'}), 401
    
    body = request.json or {}
    start_time = datetime.utcnow()
    
    # Preset strategy configurations
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
            'pairs': ['ADA/USDT', 'AVAX/USDT', 'BTC/USDT', 'DOGE/USDT', 'DOT/USDT', 'ETH/USDT', 'HBAR/USDT', 'LINK/USDT', 'LTC/USDT', 'NEAR/USDT', 'SOL/USDT', 'SUI/USDT', 'TRX/USDT', 'XRP/USDT']
        },
        'rsi-ma-bb-short': {
            'strategy_name': 'RSI + MA + BB Short Strategy',
            'direction': 'short',
            'entry_conditions': [
                {'indicator': 'RSI', 'subfields': {'RSI Length': 28, 'Timeframe': '15m', 'Condition': 'Less Than', 'Signal Value': 30}},
                {'indicator': 'MA', 'subfields': {'MA Type': 'SMA', 'Fast MA': 50, 'Slow MA': 200, 'Condition': 'Less Than', 'Timeframe': '1h'}}
            ],
            'exit_conditions': [
                {'indicator': 'BollingerBands', 'subfields': {'BB% Period': 20, 'Deviation': 1, 'Condition': 'Greater Than', 'Timeframe': '4h', 'Signal Value': 0.9}}
            ],
            'pairs': ['ADA/USDT', 'AVAX/USDT', 'BTC/USDT', 'DOGE/USDT', 'DOT/USDT', 'ETH/USDT', 'HBAR/USDT', 'LINK/USDT', 'LTC/USDT', 'NEAR/USDT', 'SOL/USDT', 'SUI/USDT', 'TRX/USDT', 'XRP/USDT']
        }
    }
    
    if strategy_id not in PRESET_STRATEGIES:
        return jsonify({'error': f'Unknown strategy: {strategy_id}'}), 404
    
    preset = PRESET_STRATEGIES[strategy_id]
    
    # Build payload with custom dates
    payload = {
        'strategy_name': preset['strategy_name'],
        'pairs': body.get('pairs', preset['pairs']),
        'max_active_deals': body.get('max_active_deals', 3),
        'trading_fee': 0.001,
        'base_order_size': 1000.0,
        'initial_balance': body.get('initial_balance', 10000.0),
        'start_date': body.get('start_date', '2024-01-01'),
        'end_date': body.get('end_date', '2024-12-31'),
        'entry_conditions': preset['entry_conditions'],
        'exit_conditions': preset['exit_conditions'],
        'conditions_active': True,
        'price_change_active': False,
        'target_profit': 0.0,
        'stop_loss_toggle': False,
        'stop_loss_value': 0.0,
        'cooldown_between_deals': 0,
        'safety_order_toggle': False,
        'reinvest_profit': 0.0,
        'risk_reduction': 0.0,
        'min_daily_volume': 0.0
    }
    
    try:
        import backtest2
        backtest2.DATA_DIR = DATA_DIR
        result = backtest2.run_backtest(payload)
        
        run_time = (datetime.utcnow() - start_time).total_seconds()
        
        if result.get('status') == 'success':
            metrics = result.get('metrics', {})
            return jsonify({
                'status': 'success',
                'runTime': run_time,
                'strategyId': strategy_id,
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
                'trades': result.get('trades', [])[:200],  # Limit trades returned
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


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"🚀 Algotcha Data Server starting on port {port}")
    print(f"📁 Data directory: {DATA_DIR}")
    print(f"📜 Scripts directory: {SCRIPTS_DIR}")
    app.run(host='0.0.0.0', port=port)

