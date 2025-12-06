# Algotcha Trading Server Deployment Guide

## Server: 46.224.99.27

## Step 1: SSH to Server

```bash
ssh root@46.224.99.27
```

## Step 2: Run Setup Script

Copy and paste this entire block:

```bash
# Update system
apt update && apt upgrade -y

# Install dependencies
apt install -y python3 python3-pip python3-venv git curl htop screen nginx

# Create app directory
mkdir -p /opt/algotcha/{data,scripts,logs}
cd /opt/algotcha

# Create Python virtual environment
python3 -m venv venv
source venv/bin/activate

# Install Python packages
pip install --upgrade pip
pip install ccxt pandas numpy ta pyarrow fastparquet flask gunicorn
```

## Step 3: Upload Files (from your Mac)

Run this from your Mac terminal:

```bash
# Upload scripts
scp /Users/andriiliudvichuk/Projects/backend/hetzner-setup/*.py root@46.224.99.27:/opt/algotcha/scripts/
scp /Users/andriiliudvichuk/Projects/backend/hetzner-setup/*.service root@46.224.99.27:/etc/systemd/system/

# Upload parquet data (this takes a while - ~45GB)
scp /Users/andriiliudvichuk/Projects/backend/static/*.parquet root@46.224.99.27:/opt/algotcha/data/

# Upload backtest results
scp -r /Users/andriiliudvichuk/Projects/backend/static/backtest_results root@46.224.99.27:/opt/algotcha/data/
```

## Step 4: Configure Services (on server)

```bash
# Copy data_server.py to main directory
cp /opt/algotcha/scripts/data_server.py /opt/algotcha/

# Edit API key (change 'your-secret-key-change-this' to your own key)
nano /etc/systemd/system/algotcha-data.service

# Enable and start service
systemctl daemon-reload
systemctl enable algotcha-data
systemctl start algotcha-data
systemctl status algotcha-data
```

## Step 5: Setup Cron for Minute Updates

```bash
# Edit crontab
crontab -e

# Add this line (runs every minute):
* * * * * /opt/algotcha/venv/bin/python /opt/algotcha/scripts/minute_update.py >> /opt/algotcha/logs/cron.log 2>&1
```

## Step 6: Configure Firewall

```bash
# Allow data server port
ufw allow 5000/tcp

# Allow SSH
ufw allow 22/tcp

# Enable firewall
ufw enable
```

## Step 7: Test

```bash
# Test health endpoint
curl http://46.224.99.27:5000/health

# Test with API key
curl -H "X-API-Key: your-secret-key-change-this" http://46.224.99.27:5000/data/status
```

## Step 8: Update Railway Backend

Set these environment variables in Railway:

```
HETZNER_DATA_URL=http://46.224.99.27:5000
HETZNER_API_KEY=your-secret-key-change-this
```

## Useful Commands

```bash
# View logs
tail -f /opt/algotcha/logs/update.log

# Restart data server
systemctl restart algotcha-data

# Check service status
systemctl status algotcha-data

# Manual update run
/opt/algotcha/venv/bin/python /opt/algotcha/scripts/minute_update.py
```

## API Endpoints

- `GET /health` - Health check (no auth)
- `GET /data/status` - List available data files
- `GET /data/latest/{symbol}` - Get latest data for symbol (e.g., BTC/USDT)
- `GET /data/range/{symbol}?limit=100` - Get last N rows
- `POST /signal/check` - Check if strategy conditions are met

## Notes

- The minute updater runs via cron every minute
- Data server runs on port 5000
- All data is stored in /opt/algotcha/data/
- Logs are in /opt/algotcha/logs/

