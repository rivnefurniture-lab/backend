#!/bin/bash
# Upload Algotcha files to Hetzner server
# Usage: ./upload_to_hetzner.sh

SERVER="root@46.224.99.27"
BACKEND_DIR="/Users/andriiliudvichuk/Projects/backend"
DOWNLOADS_DIR="/Users/andriiliudvichuk/Downloads"

echo "=========================================="
echo "  UPLOADING TO HETZNER SERVER"
echo "=========================================="

# Step 1: Create directories on server
echo "📁 Creating directories on server..."
ssh $SERVER "mkdir -p /opt/algotcha/{data,scripts,logs,backtest_results}"

# Step 2: Upload Python scripts
echo "📤 Uploading Python scripts..."
scp $BACKEND_DIR/hetzner-setup/data_server.py $SERVER:/opt/algotcha/
scp $BACKEND_DIR/hetzner-setup/minute_update.py $SERVER:/opt/algotcha/scripts/

# Step 3: Upload systemd service
echo "📤 Uploading systemd service..."
scp $BACKEND_DIR/hetzner-setup/algotcha-data.service $SERVER:/etc/systemd/system/

# Step 4: Upload fetcher (from Downloads)
echo "📤 Uploading fetcher script..."
scp $DOWNLOADS_DIR/fetcher1m.py $SERVER:/opt/algotcha/scripts/

# Step 5: Upload backtest results (small - ~6MB total)
echo "📤 Uploading backtest results..."
scp -r $BACKEND_DIR/static/backtest_results/* $SERVER:/opt/algotcha/backtest_results/

# Step 6: Upload parquet files (large - ~45GB)
echo "📤 Uploading parquet files (this will take a while)..."
echo "   Press Ctrl+C to skip if you want to upload later"
sleep 3

for file in $BACKEND_DIR/static/*.parquet; do
    if [ -f "$file" ]; then
        filename=$(basename "$file")
        echo "   Uploading $filename..."
        scp "$file" $SERVER:/opt/algotcha/data/
    fi
done

echo ""
echo "=========================================="
echo "  UPLOAD COMPLETE!"
echo "=========================================="
echo ""
echo "Next steps on server (ssh root@46.224.99.27):"
echo "1. apt update && apt install -y python3 python3-pip python3-venv"
echo "2. cd /opt/algotcha && python3 -m venv venv"
echo "3. source venv/bin/activate"
echo "4. pip install ccxt pandas numpy ta pyarrow fastparquet flask gunicorn"
echo "5. systemctl daemon-reload && systemctl enable algotcha-data && systemctl start algotcha-data"
echo "6. Add cron: * * * * * /opt/algotcha/venv/bin/python /opt/algotcha/scripts/minute_update.py"

