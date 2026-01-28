#!/bin/bash
# Comprehensive Contabo Server Inspection Script
# Run this on the Contabo server: ssh root@154.91.86.94 'bash -s' < inspect_contabo.sh

echo "========================================"
echo "   CONTABO SERVER INSPECTION REPORT"
echo "   $(date)"
echo "========================================"
echo ""

# System Info
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 SYSTEM INFORMATION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Hostname: $(hostname)"
echo "OS: $(cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2)"
echo "Kernel: $(uname -r)"
echo "IP Address: $(curl -s ifconfig.me 2>/dev/null || echo "Unable to fetch")"
echo "Uptime: $(uptime -p)"
echo ""

# CPU & Memory
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "💻 RESOURCES"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "CPU:"
lscpu | grep "Model name" | cut -d: -f2 | xargs
echo "Cores: $(nproc)"
echo ""
echo "Memory:"
free -h
echo ""
echo "Disk Usage:"
df -h /
echo ""

# Running Processes
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔄 RUNNING PROCESSES"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Python processes:"
ps aux | grep python | grep -v grep | grep -v inspect_contabo
echo ""
echo "Node processes:"
ps aux | grep node | grep -v grep
echo ""
echo "Nginx/Apache:"
ps aux | grep -E "nginx|apache" | grep -v grep
echo ""

# Services
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⚙️  SYSTEMD SERVICES"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Algotcha services:"
systemctl list-units --type=service | grep -i algotcha || echo "No algotcha services found"
echo ""
echo "algotcha-data service status:"
systemctl status algotcha-data --no-pager 2>&1 || echo "Service not found"
echo ""

# PM2 Processes
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔧 PM2 PROCESSES"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if command -v pm2 &> /dev/null; then
    pm2 list
else
    echo "PM2 not installed"
fi
echo ""

# Cron Jobs
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⏰ CRON JOBS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Root crontab:"
crontab -l 2>/dev/null || echo "No crontab for root"
echo ""

# Network & Ports
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🌐 NETWORK & LISTENING PORTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Listening ports:"
netstat -tulpn 2>/dev/null | grep LISTEN || ss -tulpn | grep LISTEN
echo ""
echo "Firewall status (ufw):"
ufw status 2>/dev/null || echo "UFW not configured"
echo ""

# Algotcha Directory
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📁 ALGOTCHA DIRECTORY STRUCTURE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -d "/opt/algotcha" ]; then
    echo "/opt/algotcha exists ✓"
    echo ""
    echo "Directory structure:"
    tree -L 2 /opt/algotcha 2>/dev/null || find /opt/algotcha -maxdepth 2 -type d
    echo ""
    echo "Data files:"
    if [ -d "/opt/algotcha/data" ]; then
        ls -lh /opt/algotcha/data/*.parquet 2>/dev/null | awk '{print $9, $5}' | head -20
        echo ""
        echo "Total parquet files: $(ls /opt/algotcha/data/*.parquet 2>/dev/null | wc -l)"
        echo "Total data size: $(du -sh /opt/algotcha/data 2>/dev/null | awk '{print $1}')"
    else
        echo "Data directory not found"
    fi
    echo ""
    echo "Scripts:"
    if [ -d "/opt/algotcha/scripts" ]; then
        ls -lh /opt/algotcha/scripts/
    else
        echo "Scripts directory not found"
    fi
    echo ""
    echo "Python environment:"
    if [ -d "/opt/algotcha/venv" ]; then
        echo "Virtual environment exists ✓"
        /opt/algotcha/venv/bin/python --version 2>/dev/null || echo "Cannot execute python"
        echo "Installed packages:"
        /opt/algotcha/venv/bin/pip list 2>/dev/null | grep -E "ccxt|pandas|numpy|ta|flask|gunicorn" || echo "Cannot list packages"
    else
        echo "Virtual environment not found"
    fi
else
    echo "/opt/algotcha does NOT exist ✗"
fi
echo ""

# Recent Logs
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 RECENT LOGS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -d "/opt/algotcha/logs" ]; then
    echo "Update log (last 20 lines):"
    tail -n 20 /opt/algotcha/logs/update.log 2>/dev/null || echo "No update log found"
    echo ""
    echo "Cron log (last 20 lines):"
    tail -n 20 /opt/algotcha/logs/cron.log 2>/dev/null || echo "No cron log found"
else
    echo "Logs directory not found"
fi
echo ""

# Data Server Test
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 DATA SERVER TEST"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Testing localhost:5000/health:"
curl -s http://localhost:5000/health 2>/dev/null || echo "Data server not responding"
echo ""

# Database
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🗄️  DATABASE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -f "/opt/algotcha/data/strategy_results.db" ]; then
    echo "Strategy results database exists ✓"
    ls -lh /opt/algotcha/data/strategy_results.db
else
    echo "Strategy results database not found"
fi
echo ""

# Environment Variables
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔐 ENVIRONMENT (from service file)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -f "/etc/systemd/system/algotcha-data.service" ]; then
    echo "Service file exists ✓"
    grep "Environment=" /etc/systemd/system/algotcha-data.service | sed 's/your-secret-key-change-this/***REDACTED***/g'
else
    echo "Service file not found"
fi
echo ""

# Installed Software
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 INSTALLED SOFTWARE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Python: $(python3 --version 2>/dev/null || echo 'Not installed')"
echo "Node: $(node --version 2>/dev/null || echo 'Not installed')"
echo "NPM: $(npm --version 2>/dev/null || echo 'Not installed')"
echo "PM2: $(pm2 --version 2>/dev/null || echo 'Not installed')"
echo "Git: $(git --version 2>/dev/null || echo 'Not installed')"
echo "Nginx: $(nginx -v 2>&1 | grep -o 'nginx/[0-9.]*' || echo 'Not installed')"
echo ""

# Summary & Recommendations
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ SUMMARY & RECOMMENDATIONS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check critical components
ISSUES=0

if [ ! -d "/opt/algotcha" ]; then
    echo "❌ /opt/algotcha directory missing"
    ((ISSUES++))
fi

if ! systemctl is-active --quiet algotcha-data 2>/dev/null; then
    echo "❌ algotcha-data service not running"
    ((ISSUES++))
fi

if ! curl -s http://localhost:5000/health &>/dev/null; then
    echo "❌ Data server not responding on port 5000"
    ((ISSUES++))
fi

if [ ! -f "/opt/algotcha/data/BTC_USDT_all_tf_merged.parquet" ]; then
    echo "⚠️  BTC data file not found - data may not be uploaded yet"
    ((ISSUES++))
fi

if ! crontab -l 2>/dev/null | grep -q "minute_update"; then
    echo "⚠️  Minute update cron job not configured"
    ((ISSUES++))
fi

if [ $ISSUES -eq 0 ]; then
    echo "✅ All systems operational!"
else
    echo ""
    echo "Found $ISSUES potential issues. Review the report above."
fi

echo ""
echo "========================================"
echo "   INSPECTION COMPLETE"
echo "========================================"

