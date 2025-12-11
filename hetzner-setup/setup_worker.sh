#!/bin/bash
# Setup Backtest Worker on Contabo

echo "="*80
echo "🤖 Setting up Algotcha Backtest Worker"
echo "="*80

# Ask for DATABASE_URL
echo ""
echo "Please enter your DATABASE_URL from Railway:"
echo "(Format: postgresql://user:password@host:port/database)"
read -p "DATABASE_URL: " DATABASE_URL

if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL is required!"
    exit 1
fi

# Create service file
echo "📝 Creating systemd service..."
cat > /etc/systemd/system/backtest-worker.service << EOF
[Unit]
Description=Algotcha Backtest Queue Worker
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/algotcha/scripts
Environment="DATABASE_URL=$DATABASE_URL"
Environment="TELEGRAM_BOT_TOKEN=8573074509:AAHDMYFF0WM6zSGkkhKHVNLTypxbw"
ExecStart=/usr/bin/python3 /opt/algotcha/scripts/backtest_worker.py
Restart=always
RestartSec=10
StandardOutput=append:/opt/algotcha/logs/backtest_worker.log
StandardError=append:/opt/algotcha/logs/backtest_worker.log

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd
echo "🔄 Reloading systemd..."
systemctl daemon-reload

# Enable and start service
echo "🚀 Starting worker..."
systemctl enable backtest-worker
systemctl start backtest-worker

# Check status
sleep 2
echo ""
echo "="*80
echo "✅ Setup Complete!"
echo "="*80
echo ""
echo "Worker Status:"
systemctl status backtest-worker --no-pager -l

echo ""
echo "📋 Useful Commands:"
echo "  systemctl status backtest-worker   # Check status"
echo "  systemctl restart backtest-worker  # Restart worker"
echo "  systemctl stop backtest-worker     # Stop worker"
echo "  tail -f /opt/algotcha/logs/backtest_worker.log  # View logs"
echo ""

