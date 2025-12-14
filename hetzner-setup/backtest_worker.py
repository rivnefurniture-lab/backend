#!/usr/bin/env python3
"""
Algotcha Backtest Queue Worker
Processes backtest jobs one at a time from the queue
"""
import os
import sys
import time
import json
import signal
import psycopg2
import requests
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

# Backtest timeout in seconds (2 hours)
BACKTEST_TIMEOUT = 2 * 60 * 60

# Add script directory to path for imports
sys.path.insert(0, '/opt/algotcha/scripts')
import backtest2

# Configuration
DATABASE_URL = os.getenv('DATABASE_URL', '')
TELEGRAM_TOKEN = '8573074509:AAHDMYFF0WM6zSGkkhKHVNLTypxbw'
GMAIL_USER = 'o.kytsuk@gmail.com'
GMAIL_PASSWORD = 'hvxe tvqo zuhf rdqo'

# Set the data directory for backtest2
backtest2.DATA_DIR = '/opt/algotcha/data/historical'

def log(msg):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {msg}", flush=True)

def get_db_connection():
    """Connect to PostgreSQL database"""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        return conn
    except Exception as e:
        log(f"❌ Database connection failed: {e}")
        return None

def send_telegram(chat_id, message):
    """Send Telegram notification"""
    if not chat_id:
        return
    
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    try:
        requests.post(url, json={
            'chat_id': chat_id,
            'text': message,
            'parse_mode': 'Markdown'
        }, timeout=10)
    except Exception as e:
        log(f"⚠️  Failed to send Telegram: {e}")

def send_email(to_email, subject, html_body):
    """Send email notification using Gmail SMTP"""
    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart
    
    if not to_email:
        return
    
    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = f'"Algotcha" <{GMAIL_USER}>'
        msg['To'] = to_email
        
        html_part = MIMEText(html_body, 'html')
        msg.attach(html_part)
        
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
            server.login(GMAIL_USER, GMAIL_PASSWORD)
            server.send_message(msg)
            
        log(f"✅ Email sent to {to_email}")
    except Exception as e:
        log(f"⚠️  Failed to send email: {e}")

def convert_numpy_types(obj):
    """Convert numpy types to native Python types for JSON/PostgreSQL compatibility"""
    import numpy as np
    
    if isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, dict):
        return {k: convert_numpy_types(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_numpy_types(item) for item in obj]
    else:
        return obj

def notify_user(notify_via, email, telegram_id, strategy_name, metrics, status, error=None):
    """Send notification to user via their preferred method"""
    
    if status == 'completed':
        # Handle 'Infinity' profit factor
        profit_factor = metrics.get('profit_factor', 0)
        if profit_factor == 'Infinity' or profit_factor == float('inf'):
            profit_factor_display = "∞"
        else:
            try:
                profit_factor_display = f"{float(profit_factor):.2f}x"
            except (ValueError, TypeError):
                profit_factor_display = "N/A"
        
        # Telegram message
        telegram_msg = f"""
🎉 *Backtest Complete!*

📊 *Strategy:* {strategy_name}

*Results:*
💰 Net Profit: {metrics.get('net_profit_usd', 'N/A')}
📈 Total Return: {metrics.get('net_profit', 0)*100:.2f}%
📉 Max Drawdown: {metrics.get('max_drawdown', 0)*100:.2f}%
🎯 Win Rate: {metrics.get('win_rate', 0)*100:.2f}%
💼 Total Trades: {metrics.get('total_trades', 0)}
🏆 Profit Factor: {profit_factor_display}

✅ View results at algotcha.com
        """.strip()
        
        # Email HTML
        email_html = f"""
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #10b981;">🎉 Backtest Complete!</h2>
          <div style="background: #f3f4f6; padding: 20px; border-radius: 8px;">
            <h3>📊 Strategy: {strategy_name}</h3>
            <table style="width: 100%;">
              <tr><td><strong>💰 Net Profit:</strong></td><td>{metrics.get('net_profit_usd', 'N/A')}</td></tr>
              <tr><td><strong>📈 Total Return:</strong></td><td>{metrics.get('net_profit', 0)*100:.2f}%</td></tr>
              <tr><td><strong>📉 Max Drawdown:</strong></td><td>{metrics.get('max_drawdown', 0)*100:.2f}%</td></tr>
              <tr><td><strong>🎯 Win Rate:</strong></td><td>{metrics.get('win_rate', 0)*100:.2f}%</td></tr>
              <tr><td><strong>💼 Total Trades:</strong></td><td>{metrics.get('total_trades', 0)}</td></tr>
              <tr><td><strong>🏆 Profit Factor:</strong></td><td>{profit_factor_display}</td></tr>
            </table>
          </div>
          <p><a href="https://algotcha.com/backtest" style="display: inline-block; background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">View Details</a></p>
        </div>
        """
        email_subject = f"✅ Backtest Complete - {strategy_name}"
    else:
        telegram_msg = f"❌ *Backtest Failed*\n\n📊 *Strategy:* {strategy_name}\n*Error:* {error or 'Unknown error'}"
        email_html = f"<h2>❌ Backtest Failed</h2><p>Strategy: {strategy_name}</p><p>Error: {error or 'Unknown error'}</p>"
        email_subject = f"❌ Backtest Failed - {strategy_name}"
    
    # Send notifications
    if notify_via in ['telegram', 'both'] and telegram_id:
        send_telegram(telegram_id, telegram_msg)
    
    if notify_via in ['email', 'both'] and email:
        send_email(email, email_subject, email_html)

def estimate_backtest_duration(payload):
    """Estimate how long a backtest will take based on parameters"""
    num_pairs = len(payload.get('pairs', []))
    
    # Calculate date range in days
    try:
        start = datetime.strptime(payload.get('start_date', '2025-06-01'), '%Y-%m-%d')
        end = datetime.strptime(payload.get('end_date', '2025-12-01'), '%Y-%m-%d')
        days = (end - start).days
    except:
        days = 180
    
    # Count conditions
    entry_conditions = len(payload.get('entry_conditions', []))
    exit_conditions = len(payload.get('exit_conditions', []))
    total_conditions = entry_conditions + exit_conditions + 1
    
    # Base time: ~3 seconds per pair per 30 days, scaled by conditions
    base_seconds_per_pair = 3 * (days / 30) * (total_conditions / 2)
    estimated_seconds = base_seconds_per_pair * num_pairs
    
    # Add overhead and clamp to reasonable range
    estimated_seconds = max(10, min(estimated_seconds * 1.2, 600))  # 10s to 10min
    
    return int(estimated_seconds)

def process_backtest(queue_item, conn):
    """Process a single backtest from the queue"""
    queue_id = queue_item[0]
    user_id = queue_item[1]
    strategy_name = queue_item[2]
    payload_json = queue_item[3]
    notify_via = queue_item[4]
    notify_email = queue_item[5]
    notify_telegram = queue_item[6]
    
    log(f"🚀 Processing backtest #{queue_id}: {strategy_name}")
    
    # Parse payload first to estimate duration
    payload = json.loads(payload_json)
    estimated_duration = estimate_backtest_duration(payload)
    log(f"📊 Estimated duration: {estimated_duration}s")
    
    # Update status to processing with estimated duration
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE "BacktestQueue" 
        SET status = 'processing', "startedAt" = NOW(), progress = 0, "estimatedSeconds" = %s
        WHERE id = %s
    """, (estimated_duration, queue_id))
    conn.commit()
    
    # Progress updater that runs in background
    progress_stop = [False]
    def update_progress():
        while not progress_stop[0]:
            try:
                elapsed = time.time() - start_time
                # Calculate progress based on elapsed vs estimated time
                # Use logarithmic curve to slow down as we approach 100%
                raw_progress = min(elapsed / estimated_duration, 0.99)
                # Smoother curve: accelerate early, slow near end
                progress = int(raw_progress * 95)  # Cap at 95% until actually done
                
                cursor.execute("""
                    UPDATE "BacktestQueue" SET progress = %s WHERE id = %s
                """, (progress, queue_id))
                conn.commit()
                log(f"   Progress: {progress}% ({int(elapsed)}s / ~{estimated_duration}s)")
            except Exception as e:
                log(f"   Progress update error: {e}")
            time.sleep(5)  # Update every 5 seconds
    
    try:
        # Start backtest
        log(f"⏳ Running backtest for {len(payload.get('pairs', []))} pairs... (timeout: {BACKTEST_TIMEOUT//60} min)")
        start_time = time.time()
        
        # Start progress updater in background thread
        import threading
        progress_thread = threading.Thread(target=update_progress, daemon=True)
        progress_thread.start()
        
        # Use ThreadPoolExecutor with timeout
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(backtest2.run_backtest, payload)
            try:
                result = future.result(timeout=BACKTEST_TIMEOUT)
            except FuturesTimeoutError:
                log(f"⚠️ Backtest timed out after {BACKTEST_TIMEOUT//60} minutes")
                raise Exception(f"Backtest timed out after {BACKTEST_TIMEOUT//60} minutes")
        
        # Stop progress updater
        progress_stop[0] = True
        elapsed = time.time() - start_time
        
        if result.get('status') == 'success':
            metrics = result.get('metrics', {})
            
            # Convert all numpy types to native Python types
            metrics = convert_numpy_types(metrics)
            result_converted = convert_numpy_types(result)
            
            log(f"✅ Backtest complete in {elapsed:.1f}s")
            log(f"   Net Profit: {metrics.get('net_profit_usd', 'N/A')}")
            log(f"   Win Rate: {metrics.get('win_rate', 0)*100:.2f}%")
            log(f"   Total Trades: {metrics.get('total_trades', 0)}")
            
            # Extract trades from df_out (only sell/exit actions represent completed trades)
            trades = []
            df_out = result_converted.get('df_out', [])
            if isinstance(df_out, list) and df_out:
                for record in df_out:
                    action = str(record.get('action', '')).lower()
                    if 'sell' in action or 'exit' in action:
                        trade = {
                            'timestamp': str(record.get('timestamp', '')),
                            'symbol': record.get('symbol', ''),
                            'action': record.get('action', ''),
                            'price': record.get('price', 0),
                            'profit_loss': record.get('profit_loss', 0),
                            'balance': record.get('real_balance', 0),
                            'trade_id': record.get('trade_id', ''),
                            'comment': record.get('trade_comment', '')
                        }
                        trades.append(trade)
            
            log(f"   Extracted {len(trades)} trade records")
            
            # Save result to database
            cursor.execute("""
                INSERT INTO "BacktestResult" (
                    name, config, pairs, "startDate", "endDate", "initialBalance",
                    "netProfit", "netProfitUsd", "maxDrawdown", "sharpeRatio", 
                    "sortinoRatio", "winRate", "totalTrades", "profitFactor", 
                    "yearlyReturn", "chartData", "trades", "createdAt", "userId"
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), %s)
                RETURNING id
            """, (
                strategy_name,
                json.dumps(payload),
                json.dumps(payload.get('pairs', [])),
                payload.get('start_date'),
                payload.get('end_date'),
                payload.get('initial_balance', 10000),
                float(metrics.get('net_profit', 0)),
                float(metrics.get('net_profit_usd', '$0').replace('$', '').replace(',', '')),
                float(metrics.get('max_drawdown', 0)),
                float(metrics.get('sharpe_ratio', 0)),
                float(metrics.get('sortino_ratio', 0)),
                float(metrics.get('win_rate', 0)),
                int(metrics.get('total_trades', 0)),
                float(metrics.get('profit_factor', 0)) if metrics.get('profit_factor') != 'Infinity' else 999.0,
                float(metrics.get('yearly_return', 0)),
                json.dumps(result_converted.get('chartData', {})),
                json.dumps(trades),
                user_id
            ))
            
            result_id = cursor.fetchone()[0]
            
            # Update queue item to completed
            cursor.execute("""
                UPDATE "BacktestQueue" 
                SET status = 'completed', "completedAt" = NOW(), progress = 100, "resultId" = %s
                WHERE id = %s
            """, (result_id, queue_id))
            conn.commit()
            
            # Send notification
            notify_user(notify_via, notify_email, notify_telegram, strategy_name, metrics, 'completed')
            
            return True
        else:
            error_msg = result.get('message', 'Unknown error')
            log(f"❌ Backtest failed: {error_msg}")
            
            cursor.execute("""
                UPDATE "BacktestQueue" 
                SET status = 'failed', "completedAt" = NOW(), "errorMessage" = %s
                WHERE id = %s
            """, (error_msg, queue_id))
            conn.commit()
            
            notify_user(notify_via, notify_email, notify_telegram, strategy_name, {}, 'failed', error_msg)
            
            return False
            
    except Exception as e:
        error_msg = str(e)
        log(f"❌ Exception: {error_msg}")
        
        cursor.execute("""
            UPDATE "BacktestQueue" 
            SET status = 'failed', "completedAt" = NOW(), "errorMessage" = %s
            WHERE id = %s
        """, (error_msg, queue_id))
        conn.commit()
        
        notify_user(notify_via, notify_email, notify_telegram, strategy_name, {}, 'failed', error_msg)
        
        return False

def main():
    """Main worker loop"""
    log("="*80)
    log("🤖 Algotcha Backtest Queue Worker Starting")
    log("="*80)
    
    conn = get_db_connection()
    if not conn:
        log("❌ Cannot start without database connection")
        return
    
    log("✅ Connected to database")
    log("⏳ Waiting for backtest jobs...")
    
    while True:
        try:
            cursor = conn.cursor()
            
            # Get next queued item
            cursor.execute("""
                SELECT id, "userId", "strategyName", payload, "notifyVia", 
                       "notifyEmail", "notifyTelegram"
                FROM "BacktestQueue"
                WHERE status = 'queued'
                ORDER BY "createdAt" ASC
                LIMIT 1
            """)
            
            queue_item = cursor.fetchone()
            
            if queue_item:
                process_backtest(queue_item, conn)
            else:
                # No items in queue, wait a bit
                time.sleep(10)
                
        except KeyboardInterrupt:
            log("\n🛑 Worker stopped by user")
            break
        except Exception as e:
            log(f"❌ Worker error: {e}")
            time.sleep(30)
    
    if conn:
        conn.close()
    
    log("👋 Worker shutting down")

if __name__ == '__main__':
    main()
