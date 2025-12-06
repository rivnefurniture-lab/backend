#!/usr/bin/env python3
"""
Algotcha Data Server
Serves parquet data via HTTP API for Railway backend
"""
import os
import json
from datetime import datetime
from flask import Flask, jsonify, request
import pandas as pd

app = Flask(__name__)

DATA_DIR = '/opt/algotcha/data'
API_KEY = os.environ.get('ALGOTCHA_API_KEY', 'your-secret-key-here')

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

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"🚀 Algotcha Data Server starting on port {port}")
    print(f"📁 Data directory: {DATA_DIR}")
    app.run(host='0.0.0.0', port=port)

