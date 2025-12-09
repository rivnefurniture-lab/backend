# Contabo Server Setup & Management

## Server Details

- **IP**: 154.91.86.94
- **IPv6**: 2a02:c207:2296:159::1
- **Location**: Hub Europe
- **OS**: Ubuntu 24.04
- **Password**: Lerochka1

## What Should Be Running

### 1. Algotcha Data Server (Port 5000)

- **Service**: `algotcha-data.service`
- **Purpose**: Serves parquet data via HTTP API, runs backtests
- **Location**: `/opt/algotcha/data_server.py`
- **Status Check**: `systemctl status algotcha-data`
- **Logs**: `journalctl -u algotcha-data -f`

### 2. Minute Data Updater (Cron)

- **Schedule**: Every minute via cron
- **Purpose**: Fetches latest 1m candles from Binance and updates all timeframes
- **Location**: `/opt/algotcha/scripts/minute_update.py`
- **Logs**: `/opt/algotcha/logs/update.log`
- **Check**: `tail -f /opt/algotcha/logs/update.log`

### 3. Data Files

- **Location**: `/opt/algotcha/data/`
- **Format**: Parquet files with all timeframes merged
- **Examples**:
  - `BTC_USDT_all_tf_merged.parquet`
  - `ETH_USDT_all_tf_merged.parquet`
  - etc.
- **Size**: ~45GB total

## Quick Inspection

### SSH into server:

```bash
ssh root@154.91.86.94
# Password: Lerochka1
```

### Run comprehensive inspection:

```bash
# Upload and run the inspection script
cd /tmp
wget https://raw.githubusercontent.com/YOUR_REPO/inspect_contabo.sh
chmod +x inspect_contabo.sh
./inspect_contabo.sh
```

Or manually upload:

```bash
# From your Mac:
scp /Users/andriiliudvichuk/Projects/backend/hetzner-setup/inspect_contabo.sh root@154.91.86.94:/tmp/
ssh root@154.91.86.94 "bash /tmp/inspect_contabo.sh"
```

## Manual Checks

### 1. Check if data server is running:

```bash
systemctl status algotcha-data
curl http://localhost:5000/health
```

### 2. Check cron job:

```bash
crontab -l | grep minute_update
```

### 3. Check recent updates:

```bash
tail -50 /opt/algotcha/logs/update.log
```

### 4. Check data files:

```bash
ls -lh /opt/algotcha/data/*.parquet | head
du -sh /opt/algotcha/data/
```

### 5. Test data endpoint (with API key):

```bash
API_KEY="your-actual-api-key-here"
curl -H "X-API-Key: $API_KEY" http://localhost:5000/data/status
```

### 6. Check running processes:

```bash
ps aux | grep python
netstat -tulpn | grep :5000
```

## Common Issues & Fixes

### Data Server Not Running

```bash
# Check status
systemctl status algotcha-data

# Check logs for errors
journalctl -u algotcha-data -n 50

# Restart service
systemctl restart algotcha-data

# If service doesn't exist, reload systemd
systemctl daemon-reload
systemctl enable algotcha-data
systemctl start algotcha-data
```

### Cron Job Not Running

```bash
# Check if cron is installed and running
systemctl status cron

# Add cron job if missing
crontab -e
# Add this line:
* * * * * /opt/algotcha/venv/bin/python /opt/algotcha/scripts/minute_update.py >> /opt/algotcha/logs/cron.log 2>&1

# Check if it's running
tail -f /opt/algotcha/logs/cron.log
```

### Data Files Missing

```bash
# Check if data directory exists
ls -la /opt/algotcha/data/

# If empty, you need to upload parquet files from your Mac:
# On your Mac:
scp /Users/andriiliudvichuk/Projects/backend/static/*.parquet root@154.91.86.94:/opt/algotcha/data/
```

### Python Environment Issues

```bash
# Check if venv exists
ls -la /opt/algotcha/venv/

# Test Python
/opt/algotcha/venv/bin/python --version

# Check installed packages
/opt/algotcha/venv/bin/pip list

# Reinstall packages if needed
cd /opt/algotcha
source venv/bin/activate
pip install --upgrade pip
pip install ccxt pandas numpy ta pyarrow fastparquet flask gunicorn redis
```

### Port 5000 Already in Use

```bash
# Find what's using port 5000
lsof -i :5000
# or
netstat -tulpn | grep :5000

# Kill the process or change the port in the service file
nano /etc/systemd/system/algotcha-data.service
# Change Environment="PORT=5000" to another port

systemctl daemon-reload
systemctl restart algotcha-data
```

## Fresh Setup (If Nothing Is Configured)

### 1. Update system:

```bash
apt update && apt upgrade -y
```

### 2. Install dependencies:

```bash
apt install -y python3 python3-pip python3-venv git curl htop tree redis-server
```

### 3. Create directory structure:

```bash
mkdir -p /opt/algotcha/{data,scripts,logs,backtest_results}
cd /opt/algotcha
```

### 4. Create Python virtual environment:

```bash
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install ccxt pandas numpy ta pyarrow fastparquet flask gunicorn redis
```

### 5. Upload files from your Mac:

```bash
# Run this on your Mac:
cd /Users/andriiliudvichuk/Projects/backend/hetzner-setup
./upload_to_hetzner.sh
# (Update the server IP in the script to 154.91.86.94)
```

Or manually:

```bash
# From your Mac:
scp data_server.py root@154.91.86.94:/opt/algotcha/
scp minute_update.py root@154.91.86.94:/opt/algotcha/scripts/
scp algotcha-data.service root@154.91.86.94:/etc/systemd/system/
```

### 6. Configure the service:

```bash
# Edit service file to set API key
nano /etc/systemd/system/algotcha-data.service
# Change ALGOTCHA_API_KEY to a secure random string

# Enable and start
systemctl daemon-reload
systemctl enable algotcha-data
systemctl start algotcha-data
```

### 7. Setup cron job:

```bash
crontab -e
# Add:
* * * * * /opt/algotcha/venv/bin/python /opt/algotcha/scripts/minute_update.py >> /opt/algotcha/logs/cron.log 2>&1
```

### 8. Configure firewall:

```bash
ufw allow 22/tcp   # SSH
ufw allow 5000/tcp # Data server (only if external access needed)
ufw enable
```

## API Endpoints

Once running, the data server provides these endpoints:

- `GET /health` - Health check (no auth)
- `GET /data/status` - List data files (requires API key)
- `GET /data/date-range` - Get available date range (requires API key)
- `GET /data/latest/{symbol}` - Latest data for symbol (requires API key)
- `GET /data/range/{symbol}?limit=100` - Last N rows (requires API key)
- `POST /signal/check` - Check strategy conditions (requires API key)
- `POST /backtest/run` - Run custom backtest (requires API key)
- `POST /backtest/preset/{strategy_id}` - Run preset backtest (requires API key)
- `GET /strategy/results/{strategy_id}` - Get strategy results (requires API key)

## Connect Backend to Contabo

In your Railway backend, set these environment variables:

```
HETZNER_DATA_URL=http://154.91.86.94:5000
HETZNER_API_KEY=your-secret-api-key-here
```

(Replace with your actual API key from the service file)

## Monitoring

### Real-time monitoring:

```bash
# Data server logs
journalctl -u algotcha-data -f

# Minute update logs
tail -f /opt/algotcha/logs/update.log

# System resources
htop

# Disk usage
watch -n 5 'df -h / && du -sh /opt/algotcha/data/'
```

### Check last successful update:

```bash
ls -lht /opt/algotcha/data/*.parquet | head -5
```

## Backup Strategy

### Backup data (recommended weekly):

```bash
# On Contabo server:
cd /opt/algotcha
tar -czf data_backup_$(date +%Y%m%d).tar.gz data/*.parquet

# Download to your Mac:
scp root@154.91.86.94:/opt/algotcha/data_backup_*.tar.gz ~/Backups/
```

### Backup database:

```bash
# On Contabo server:
cp /opt/algotcha/data/strategy_results.db /opt/algotcha/data/strategy_results.db.backup

# Download to your Mac:
scp root@154.91.86.94:/opt/algotcha/data/strategy_results.db ~/Backups/
```

## Useful Commands Cheat Sheet

```bash
# Service management
systemctl status algotcha-data
systemctl restart algotcha-data
systemctl stop algotcha-data
journalctl -u algotcha-data -f

# Check logs
tail -f /opt/algotcha/logs/update.log
tail -f /opt/algotcha/logs/cron.log

# Test API
curl http://localhost:5000/health
curl -H "X-API-Key: YOUR_KEY" http://localhost:5000/data/status

# Check processes
ps aux | grep python
netstat -tulpn | grep LISTEN

# Disk & resources
df -h
du -sh /opt/algotcha/data/
free -h
htop

# Cron
crontab -l
crontab -e

# Firewall
ufw status
ufw allow 5000/tcp
```
