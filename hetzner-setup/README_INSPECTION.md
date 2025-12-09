# 🔍 Contabo Server Inspection Guide

## Quick Start

Since I couldn't connect to your Contabo server directly (firewall/security), here's how you can inspect it:

### Method 1: Run Inspection Script Remotely (Recommended)

```bash
# From your Mac, run this one command:
ssh root@154.91.86.94 'bash -s' < /Users/andriiliudvichuk/Projects/backend/hetzner-setup/inspect_contabo.sh
```

**Password**: Lerochka1

This will:

- ✅ Show system information
- ✅ List running processes
- ✅ Check services status
- ✅ Verify data files
- ✅ Test endpoints
- ✅ Show recent logs
- ✅ Give recommendations

### Method 2: SSH and Run Manually

```bash
# 1. SSH to server
ssh root@154.91.86.94

# 2. Upload inspection script
exit  # if you're already in
scp /Users/andriiliudvichuk/Projects/backend/hetzner-setup/inspect_contabo.sh root@154.91.86.94:/tmp/

# 3. SSH back and run
ssh root@154.91.86.94
bash /tmp/inspect_contabo.sh
```

### Method 3: Quick Manual Check

```bash
ssh root@154.91.86.94 << 'EOF'
echo "=== System Info ==="
uname -a
echo ""
echo "=== Disk Usage ==="
df -h /
echo ""
echo "=== Running Python Processes ==="
ps aux | grep python | grep -v grep
echo ""
echo "=== Algotcha Service ==="
systemctl status algotcha-data --no-pager
echo ""
echo "=== Listening Ports ==="
ss -tulpn | grep LISTEN
echo ""
echo "=== Algotcha Directory ==="
ls -la /opt/algotcha/
echo ""
echo "=== Data Files ==="
ls -lh /opt/algotcha/data/*.parquet 2>/dev/null | head -5 || echo "No parquet files"
echo ""
echo "=== Recent Logs ==="
tail -20 /opt/algotcha/logs/update.log 2>/dev/null || echo "No logs yet"
echo ""
echo "=== Test Health Endpoint ==="
curl -s http://localhost:5000/health 2>/dev/null || echo "Data server not responding"
EOF
```

## What Should Be Running

Based on your project, the Contabo server should have:

### 1. 🐍 Algotcha Data Server

- **Service**: `algotcha-data` (systemd)
- **Port**: 5000
- **Purpose**: Serves OHLCV data, runs backtests
- **Check**: `curl http://localhost:5000/health`

### 2. ⏰ Minute Updater (Cron)

- **Schedule**: Every minute
- **Purpose**: Fetches new 1m candles from Binance
- **Location**: `/opt/algotcha/scripts/minute_update.py`
- **Log**: `/opt/algotcha/logs/update.log`

### 3. 📊 Data Files

- **Location**: `/opt/algotcha/data/`
- **Size**: ~45GB of parquet files
- **Format**: `{SYMBOL}_all_tf_merged.parquet`

### 4. 🗄️ Strategy Database

- **Location**: `/opt/algotcha/data/strategy_results.db`
- **Purpose**: Stores continuous strategy results

## Expected Directory Structure

```
/opt/algotcha/
├── data/
│   ├── BTC_USDT_all_tf_merged.parquet
│   ├── ETH_USDT_all_tf_merged.parquet
│   ├── ... (more symbols)
│   └── strategy_results.db
├── scripts/
│   ├── minute_update.py
│   ├── backtest2.py
│   └── continuous_strategy.py
├── logs/
│   ├── update.log
│   └── cron.log
├── backtest_results/
├── venv/  (Python virtual environment)
└── data_server.py

/etc/systemd/system/
└── algotcha-data.service
```

## Common Scenarios

### Scenario 1: Nothing is set up yet

If the inspection shows `/opt/algotcha` doesn't exist:

```bash
# Run the upload script to set everything up
cd /Users/andriiliudvichuk/Projects/backend/hetzner-setup
./upload_to_contabo.sh
```

Then follow the setup instructions in `CONTABO_SETUP.md`

### Scenario 2: Server is set up but service isn't running

```bash
ssh root@154.91.86.94
systemctl start algotcha-data
systemctl status algotcha-data
```

### Scenario 3: Data files are missing

```bash
# Upload parquet files from your Mac
rsync -avz --progress /Users/andriiliudvichuk/Projects/backend/static/*.parquet root@154.91.86.94:/opt/algotcha/data/
```

### Scenario 4: Cron job not configured

```bash
ssh root@154.91.86.94
crontab -e
# Add this line:
* * * * * /opt/algotcha/venv/bin/python /opt/algotcha/scripts/minute_update.py >> /opt/algotcha/logs/cron.log 2>&1
```

## Files Created for You

I've created these helper files in your project:

1. **`inspect_contabo.sh`** - Comprehensive inspection script
2. **`CONTABO_SETUP.md`** - Full setup and troubleshooting guide
3. **`upload_to_contabo.sh`** - Upload all files to Contabo
4. **`README_INSPECTION.md`** - This file

## Next Steps

1. **Run the inspection**:

   ```bash
   ssh root@154.91.86.94 'bash -s' < /Users/andriiliudvichuk/Projects/backend/hetzner-setup/inspect_contabo.sh
   ```

2. **Review the output** to see what's running

3. **Take action** based on what's missing:
   - If nothing exists → Run `./upload_to_contabo.sh`
   - If service not running → Start it
   - If data missing → Upload parquet files
   - If cron not configured → Add cron job

4. **Update Railway backend** with new endpoint:
   ```
   HETZNER_DATA_URL=http://154.91.86.94:5000
   HETZNER_API_KEY=<your-api-key>
   ```

## Need Help?

See `CONTABO_SETUP.md` for:

- Full setup instructions
- Troubleshooting common issues
- API endpoints documentation
- Backup strategies
- Monitoring commands

## Quick Reference Commands

```bash
# Inspect server
ssh root@154.91.86.94 'bash -s' < inspect_contabo.sh

# Upload everything
./upload_to_contabo.sh

# Check service
ssh root@154.91.86.94 "systemctl status algotcha-data"

# View logs
ssh root@154.91.86.94 "tail -50 /opt/algotcha/logs/update.log"

# Test endpoint
ssh root@154.91.86.94 "curl http://localhost:5000/health"
```

---

**Server**: 154.91.86.94 | **Password**: Lerochka1 | **OS**: Ubuntu 24.04
