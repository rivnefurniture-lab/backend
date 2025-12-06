#!/usr/bin/env python3
"""
Backtest Worker with Job Queue
Handles async backtest processing for scalability
"""
import os
import sys
import json
import time
import redis
import hashlib
from datetime import datetime, timedelta

# Add scripts directory to path
sys.path.insert(0, '/opt/algotcha/scripts')

REDIS_URL = os.environ.get('REDIS_URL', 'redis://localhost:6379')
DATA_DIR = '/opt/algotcha/data'
CACHE_TTL = 3600 * 24  # 24 hours cache

# Connect to Redis
try:
    r = redis.from_url(REDIS_URL)
    r.ping()
    print("✅ Redis connected")
except:
    r = None
    print("⚠️ Redis not available, running without cache")


def get_cache_key(config: dict) -> str:
    """Generate cache key from backtest config"""
    # Normalize config for consistent hashing
    normalized = json.dumps(config, sort_keys=True)
    return f"backtest:{hashlib.sha256(normalized.encode()).hexdigest()[:16]}"


def get_cached_result(config: dict) -> dict | None:
    """Get cached backtest result if exists"""
    if not r:
        return None
    
    key = get_cache_key(config)
    cached = r.get(key)
    if cached:
        return json.loads(cached)
    return None


def cache_result(config: dict, result: dict, ttl: int = CACHE_TTL):
    """Cache backtest result"""
    if not r:
        return
    
    key = get_cache_key(config)
    r.setex(key, ttl, json.dumps(result))


def run_backtest(config: dict) -> dict:
    """Run actual backtest using backtest2.py"""
    import backtest2
    
    backtest2.DATA_DIR = DATA_DIR
    
    # Build payload
    payload = {
        'strategy_name': config.get('strategy_name', 'API Backtest'),
        'pairs': config.get('pairs', ['BTC/USDT']),
        'max_active_deals': config.get('max_active_deals', 3),
        'trading_fee': config.get('trading_fee', 0.001),
        'base_order_size': config.get('base_order_size', 1000.0),
        'initial_balance': config.get('initial_balance', 10000.0),
        'start_date': config.get('start_date', '2024-01-01'),
        'end_date': config.get('end_date', '2024-12-31'),
        'entry_conditions': config.get('entry_conditions', []),
        'exit_conditions': config.get('exit_conditions', []),
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
    
    result = backtest2.run_backtest(payload)
    return result


def process_job(job_id: str, config: dict) -> dict:
    """Process a single backtest job"""
    start_time = time.time()
    
    # Update job status
    if r:
        r.hset(f"job:{job_id}", "status", "running")
        r.hset(f"job:{job_id}", "started_at", datetime.utcnow().isoformat())
    
    try:
        # Check cache first
        cached = get_cached_result(config)
        if cached:
            result = {
                'status': 'success',
                'cached': True,
                'metrics': cached.get('metrics', {}),
                'runTime': time.time() - start_time
            }
        else:
            # Run actual backtest
            bt_result = run_backtest(config)
            
            if bt_result.get('status') == 'success':
                metrics = bt_result.get('metrics', {})
                result = {
                    'status': 'success',
                    'cached': False,
                    'metrics': {
                        'net_profit': round(metrics.get('net_profit', 0) * 100, 2),
                        'net_profit_usd': metrics.get('net_profit_usd', '$0'),
                        'total_profit': round(metrics.get('total_profit', 0) * 100, 2),
                        'max_drawdown': round(metrics.get('max_drawdown', 0) * 100, 2),
                        'sharpe_ratio': round(metrics.get('sharpe_ratio', 0), 2),
                        'win_rate': round(metrics.get('win_rate', 0), 2),
                        'total_trades': metrics.get('total_trades', 0),
                        'profit_factor': metrics.get('profit_factor', 0),
                    },
                    'runTime': time.time() - start_time
                }
                # Cache the result
                cache_result(config, result)
            else:
                result = {
                    'status': 'error',
                    'error': bt_result.get('message', 'Backtest failed'),
                    'runTime': time.time() - start_time
                }
        
        # Update job with result
        if r:
            r.hset(f"job:{job_id}", "status", "completed")
            r.hset(f"job:{job_id}", "result", json.dumps(result))
            r.hset(f"job:{job_id}", "completed_at", datetime.utcnow().isoformat())
            r.expire(f"job:{job_id}", 3600)  # Keep job for 1 hour
        
        return result
        
    except Exception as e:
        error_result = {
            'status': 'error',
            'error': str(e),
            'runTime': time.time() - start_time
        }
        if r:
            r.hset(f"job:{job_id}", "status", "failed")
            r.hset(f"job:{job_id}", "error", str(e))
        return error_result


def worker_loop():
    """Main worker loop - processes jobs from queue"""
    if not r:
        print("❌ Redis required for worker mode")
        return
    
    print("🔄 Worker started, waiting for jobs...")
    
    while True:
        try:
            # Block until a job is available
            job_data = r.brpop('backtest_queue', timeout=30)
            
            if job_data:
                _, job_json = job_data
                job = json.loads(job_json)
                job_id = job.get('job_id')
                config = job.get('config', {})
                
                print(f"📊 Processing job {job_id}")
                result = process_job(job_id, config)
                print(f"✅ Job {job_id} completed: {result.get('status')}")
            
        except Exception as e:
            print(f"❌ Worker error: {e}")
            time.sleep(5)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', action='store_true', help='Run as background worker')
    args = parser.parse_args()
    
    if args.worker:
        worker_loop()
    else:
        print("Use --worker to start the worker process")

