#!/usr/bin/env python3
"""
Continuous Strategy Runner
- Runs featured strategies continuously like live trading
- Stores all trades in SQLite database for instant queries
- Updates every minute with new candle data
- Sends Telegram notifications for errors and important events
"""
import os
import sys
import json
import time
import sqlite3
import requests
import fcntl
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Any
import pandas as pd
import numpy as np

# Configuration
DATA_DIR = '/opt/algotcha/data'
INCREMENTAL_DIR = '/opt/algotcha/data/incremental'
DB_FILE = '/opt/algotcha/data/strategy_results.db'
STATE_FILE = '/opt/algotcha/state/strategy_state.json'
LOCK_FILE = '/tmp/continuous_strategy.lock'
LOG_DIR = '/opt/algotcha/logs'

# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN = '8573074509:AAHDMYFFO0WM6zSGgkkHschKHVNLpTypxbw'
TELEGRAM_CHAT_ID = 245224666  # Your Telegram chat ID

os.makedirs(LOG_DIR, exist_ok=True)
os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)

# Featured Strategies Configuration
# RSI + MA + BB Long Strategy - Momentum/Trend Following
# 
# ENTRY CONDITIONS (must all be true):
#   1. RSI(28) on 15m > 70 = Strong bullish momentum
#   2. SMA(50) > SMA(200) on 1h = Confirmed uptrend (Golden Cross)
#
# EXIT CONDITIONS:
#   1. BB%B(20,1) on 4h < 0.1 = Price fell to lower band (take profit/cut loss)
#
# REALISTIC TRADING LOGIC:
#   - Buy when momentum is strong AND trend is bullish
#   - Sell when price retraces to lower bollinger band
#   - 0.1% trading fee per trade
#   - Max 3 concurrent positions
#   - $1000 per position, $10000 starting capital
#
FEATURED_STRATEGIES = {
    'rsi-ma-bb-long': {
        'name': 'RSI + MA + BB Long Strategy',
        'direction': 'long',
        'pairs': ['ADA/USDT', 'AVAX/USDT', 'BTC/USDT', 'DOGE/USDT', 'DOT/USDT', 
                  'ETH/USDT', 'HBAR/USDT', 'LINK/USDT', 'LTC/USDT', 'NEAR/USDT', 
                  'SOL/USDT', 'SUI/USDT', 'TRX/USDT', 'XRP/USDT'],
        'entry_conditions': {
            # RSI > 70 indicates strong bullish momentum (buy high to sell higher)
            'RSI_28': {'operator': '>', 'value': 70},
            # SMA 50 > SMA 200 = bullish trend (Golden Cross)
            'SMA_50': {'operator': '>', 'ref': 'SMA_200'}
        },
        'exit_conditions': {
            # BB%B < 0.1 means price near lower band - exit position
            'BB_%B_20_1': {'operator': '<', 'value': 0.1}
        },
        'base_order_size': 1000,
        'max_active_deals': 3,
        'initial_balance': 10000,
        'trading_fee': 0.001  # 0.1% per trade
    }
}


def log(msg: str, level: str = 'INFO'):
    """Log message to file and console"""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{timestamp}] [{level}] {msg}"
    print(line)
    log_file = os.path.join(LOG_DIR, f"strategy_{datetime.now().strftime('%Y%m%d')}.log")
    with open(log_file, 'a') as f:
        f.write(line + '\n')


def send_telegram(message: str, is_error: bool = False):
    """Send message to Telegram"""
    global TELEGRAM_CHAT_ID
    
    try:
        # Try to get chat_id from state if not set
        if not TELEGRAM_CHAT_ID:
            state = get_state()
            TELEGRAM_CHAT_ID = state.get('telegram_chat_id')
        
        if not TELEGRAM_CHAT_ID:
            # Can't send without chat_id, log instead
            log(f"TELEGRAM (no chat_id): {message}", 'WARN')
            return
        
        prefix = "🚨 ERROR: " if is_error else "📊 "
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        data = {
            'chat_id': TELEGRAM_CHAT_ID,
            'text': f"{prefix}{message}",
            'parse_mode': 'HTML'
        }
        response = requests.post(url, data=data, timeout=10)
        if response.status_code != 200:
            log(f"Telegram error: {response.text}", 'ERROR')
    except Exception as e:
        log(f"Telegram exception: {e}", 'ERROR')


def init_database():
    """Initialize SQLite database"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    
    # Trades table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_id TEXT NOT NULL,
            timestamp DATETIME NOT NULL,
            symbol TEXT NOT NULL,
            action TEXT NOT NULL,
            price REAL NOT NULL,
            order_size REAL NOT NULL,
            profit_loss REAL DEFAULT 0,
            balance REAL NOT NULL,
            trade_id TEXT,
            comment TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(strategy_id, timestamp, symbol, action)
        )
    ''')
    
    # Strategy state table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS strategy_state (
            strategy_id TEXT PRIMARY KEY,
            balance REAL NOT NULL,
            active_deals INTEGER DEFAULT 0,
            total_trades INTEGER DEFAULT 0,
            total_profit REAL DEFAULT 0,
            last_processed DATETIME,
            positions TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Metrics history table (for charts)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS metrics_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_id TEXT NOT NULL,
            timestamp DATETIME NOT NULL,
            balance REAL NOT NULL,
            drawdown REAL DEFAULT 0,
            UNIQUE(strategy_id, timestamp)
        )
    ''')
    
    conn.commit()
    conn.close()
    log("Database initialized")


def get_state() -> Dict:
    """Get strategy state from file"""
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, 'r') as f:
                return json.load(f)
    except:
        pass
    return {}


def save_state(state: Dict):
    """Save strategy state to file"""
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2, default=str)


def get_strategy_state(strategy_id: str) -> Dict:
    """Get current state of a strategy from database"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM strategy_state WHERE strategy_id = ?', (strategy_id,))
    row = cursor.fetchone()
    conn.close()
    
    if row:
        return {
            'strategy_id': row[0],
            'balance': row[1],
            'active_deals': row[2],
            'total_trades': row[3],
            'total_profit': row[4],
            'last_processed': row[5],
            'positions': json.loads(row[6]) if row[6] else {}
        }
    
    # Initialize new strategy state
    config = FEATURED_STRATEGIES.get(strategy_id, {})
    return {
        'strategy_id': strategy_id,
        'balance': config.get('initial_balance', 10000),
        'active_deals': 0,
        'total_trades': 0,
        'total_profit': 0,
        'last_processed': None,
        'positions': {}
    }


def save_strategy_state(state: Dict):
    """Save strategy state to database"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO strategy_state 
        (strategy_id, balance, active_deals, total_trades, total_profit, last_processed, positions, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        state['strategy_id'],
        state['balance'],
        state['active_deals'],
        state['total_trades'],
        state['total_profit'],
        state['last_processed'],
        json.dumps(state['positions']),
        datetime.now().isoformat()
    ))
    conn.commit()
    conn.close()


def record_trade(strategy_id: str, timestamp: str, symbol: str, action: str, 
                 price: float, order_size: float, profit_loss: float, balance: float,
                 trade_id: str = None, comment: str = None):
    """Record a trade to database"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT OR IGNORE INTO trades 
            (strategy_id, timestamp, symbol, action, price, order_size, profit_loss, balance, trade_id, comment)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (strategy_id, timestamp, symbol, action, price, order_size, profit_loss, balance, trade_id, comment))
        conn.commit()
    except sqlite3.IntegrityError:
        pass  # Duplicate trade, ignore
    conn.close()


def record_metrics(strategy_id: str, timestamp: str, balance: float, drawdown: float):
    """Record balance/drawdown for charts"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT OR IGNORE INTO metrics_history 
            (strategy_id, timestamp, balance, drawdown)
            VALUES (?, ?, ?, ?)
        ''', (strategy_id, timestamp, balance, drawdown))
        conn.commit()
    except:
        pass
    conn.close()


def check_condition(value: float, condition: Dict, data: Dict) -> bool:
    """Check if a condition is met"""
    operator = condition.get('operator', '>')
    threshold = condition.get('value')
    ref_field = condition.get('ref')
    
    if ref_field:
        threshold = data.get(ref_field, 0)
    
    if threshold is None:
        return False
    
    if operator == '>':
        return value > threshold
    elif operator == '<':
        return value < threshold
    elif operator == '>=':
        return value >= threshold
    elif operator == '<=':
        return value <= threshold
    elif operator == '==':
        return value == threshold
    
    return False


def get_latest_data(symbol: str) -> Optional[Dict]:
    """Get latest data for a symbol from incremental files"""
    clean = symbol.replace('/', '_')
    
    # Try incremental file first
    inc_file = os.path.join(INCREMENTAL_DIR, f"{clean}_incremental.parquet")
    if os.path.exists(inc_file):
        try:
            df = pd.read_parquet(inc_file)
            if not df.empty:
                row = df.iloc[-1].to_dict()
                # Convert numpy types
                for k, v in row.items():
                    if hasattr(v, 'item'):
                        row[k] = v.item()
                    elif pd.isna(v):
                        row[k] = None
                return row
        except Exception as e:
            log(f"Error reading incremental for {symbol}: {e}", 'WARN')
    
    # Fall back to main file
    main_file = os.path.join(DATA_DIR, f"{clean}_all_tf_merged.parquet")
    if os.path.exists(main_file):
        try:
            df = pd.read_parquet(main_file)
            if not df.empty:
                row = df.iloc[-1].to_dict()
                for k, v in row.items():
                    if hasattr(v, 'item'):
                        row[k] = v.item()
                    elif pd.isna(v):
                        row[k] = None
                return row
        except Exception as e:
            log(f"Error reading main file for {symbol}: {e}", 'ERROR')
    
    return None


def process_strategy_tick(strategy_id: str, config: Dict, state: Dict) -> Dict:
    """Process one tick for a strategy - check signals, execute trades"""
    positions = state['positions']
    balance = state['balance']
    base_order_size = config.get('base_order_size', 1000)
    max_active_deals = config.get('max_active_deals', 3)
    direction = config.get('direction', 'long')
    
    trades_made = []
    
    for symbol in config['pairs']:
        data = get_latest_data(symbol)
        if not data:
            continue
        
        timestamp = str(data.get('timestamp', datetime.now()))
        price = data.get('close', 0)
        
        if price <= 0:
            continue
        
        # Check if we have an open position for this symbol
        position = positions.get(symbol)
        
        if position:
            # Check exit conditions
            exit_triggered = True
            for field, condition in config['exit_conditions'].items():
                value = data.get(field)
                if value is None:
                    exit_triggered = False
                    break
                if not check_condition(value, condition, data):
                    exit_triggered = False
                    break
            
            if exit_triggered:
                # Close position
                entry_price = position['entry_price']
                order_size = position['order_size']
                
                if direction == 'long':
                    profit_loss = (price - entry_price) / entry_price * order_size
                else:
                    profit_loss = (entry_price - price) / entry_price * order_size
                
                balance += order_size + profit_loss
                
                record_trade(strategy_id, timestamp, symbol, 'SELL', price, order_size, 
                           profit_loss, balance, position.get('trade_id'), 'Exit triggered')
                
                trades_made.append({
                    'action': 'SELL',
                    'symbol': symbol,
                    'price': price,
                    'profit_loss': profit_loss
                })
                
                del positions[symbol]
                state['total_trades'] += 1
                state['total_profit'] += profit_loss
                
                # Telegram notification for significant trades
                if abs(profit_loss) > 50:
                    send_telegram(f"🔔 {config['name']}\n{symbol} CLOSED\nP&L: ${profit_loss:.2f}")
        
        else:
            # Check entry conditions
            if len(positions) >= max_active_deals:
                continue
            
            if balance < base_order_size:
                continue
            
            entry_triggered = True
            for field, condition in config['entry_conditions'].items():
                value = data.get(field)
                if value is None:
                    entry_triggered = False
                    break
                if not check_condition(value, condition, data):
                    entry_triggered = False
                    break
            
            if entry_triggered:
                # Open position
                trade_id = f"{strategy_id}-{symbol.replace('/', '')}-{int(time.time())}"
                
                balance -= base_order_size
                
                positions[symbol] = {
                    'entry_price': price,
                    'entry_time': timestamp,
                    'order_size': base_order_size,
                    'trade_id': trade_id
                }
                
                record_trade(strategy_id, timestamp, symbol, 'BUY', price, base_order_size, 
                           0, balance, trade_id, 'Entry triggered')
                
                trades_made.append({
                    'action': 'BUY',
                    'symbol': symbol,
                    'price': price
                })
                
                # Telegram notification
                send_telegram(f"🟢 {config['name']}\n{symbol} OPENED at ${price:.2f}")
    
    # Update state
    state['balance'] = balance
    state['positions'] = positions
    state['active_deals'] = len(positions)
    state['last_processed'] = datetime.now().isoformat()
    
    # Record metrics for chart
    max_balance = state.get('max_balance', balance)
    if balance > max_balance:
        max_balance = balance
        state['max_balance'] = max_balance
    drawdown = (max_balance - balance) / max_balance if max_balance > 0 else 0
    
    record_metrics(strategy_id, state['last_processed'], balance, drawdown)
    
    return state


def run_initial_backtest(strategy_id: str, config: Dict):
    """Run initial backtest from 2020 to now to populate database"""
    log(f"Running initial backtest for {strategy_id}...")
    
    # This would run the full backtest - for now just initialize state
    state = get_strategy_state(strategy_id)
    state['last_processed'] = '2020-01-01 00:00:00'
    save_strategy_state(state)
    
    send_telegram(f"📊 Initialized strategy: {config['name']}\nStarting continuous monitoring...")


def main():
    """Main loop"""
    # Acquire lock
    lock_fd = open(LOCK_FILE, 'w')
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except IOError:
        print("Another instance running, exiting")
        return
    
    try:
        log("=" * 50)
        log("Starting continuous strategy runner...")
        
        # Initialize database
        init_database()
        
        # Process each featured strategy
        for strategy_id, config in FEATURED_STRATEGIES.items():
            try:
                state = get_strategy_state(strategy_id)
                
                # Check if we need initial backtest
                if not state.get('last_processed'):
                    run_initial_backtest(strategy_id, config)
                    state = get_strategy_state(strategy_id)
                
                # Process current tick
                state = process_strategy_tick(strategy_id, config, state)
                save_strategy_state(state)
                
                log(f"✅ {strategy_id}: Balance=${state['balance']:.2f}, Positions={state['active_deals']}")
                
            except Exception as e:
                log(f"❌ {strategy_id}: {e}", 'ERROR')
                send_telegram(f"Strategy error: {strategy_id}\n{str(e)[:100]}", is_error=True)
        
        log("Done!")
        
    except Exception as e:
        log(f"Fatal error: {e}", 'ERROR')
        send_telegram(f"FATAL ERROR in strategy runner:\n{str(e)[:200]}", is_error=True)
        
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()


# Telegram setup endpoint (call once to set chat_id)
def setup_telegram_webhook():
    """Get updates to find chat_id"""
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates"
    response = requests.get(url)
    print(response.json())


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--setup-telegram', action='store_true', help='Get Telegram chat_id')
    args = parser.parse_args()
    
    if args.setup_telegram:
        setup_telegram_webhook()
    else:
        main()

