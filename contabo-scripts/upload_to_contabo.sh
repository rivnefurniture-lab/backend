#!/bin/bash
# Upload Algotcha files to Contabo server
# Usage: ./upload_to_contabo.sh

SERVER="root@154.91.86.94"
BACKEND_DIR="/Users/andriiliudvichuk/Projects/backend"
DOWNLOADS_DIR="/Users/andriiliudvichuk/Downloads"

echo "=========================================="
echo "  UPLOADING TO CONTABO SERVER"
echo "  IP: 154.91.86.94"
echo "=========================================="

# Step 1: Create directories on server
echo "📁 Creating directories on server..."
ssh $SERVER "mkdir -p /opt/algotcha/{data,scripts,logs,backtest_results}"

# Step 2: Upload Python scripts
echo "📤 Uploading Python scripts..."
scp $BACKEND_DIR/hetzner-setup/data_server.py $SERVER:/opt/algotcha/
scp $BACKEND_DIR/hetzner-setup/minute_update.py $SERVER:/opt/algotcha/scripts/
scp $BACKEND_DIR/hetzner-setup/minute_update_v2.py $SERVER:/opt/algotcha/scripts/ 2>/dev/null || echo "  (minute_update_v2.py not found, skipping)"
scp $BACKEND_DIR/hetzner-setup/continuous_strategy.py $SERVER:/opt/algotcha/scripts/ 2>/dev/null || echo "  (continuous_strategy.py not found, skipping)"

# Step 3: Upload systemd service
echo "📤 Uploading systemd service..."
scp $BACKEND_DIR/hetzner-setup/algotcha-data.service $SERVER:/etc/systemd/system/

# Step 4: Upload backtest scripts
echo "📤 Uploading backtest scripts..."
scp $BACKEND_DIR/scripts/backtest2.py $SERVER:/opt/algotcha/scripts/ 2>/dev/null || echo "  (backtest2.py not found in scripts/, skipping)"

# Step 5: Upload backtest results (small - ~6MB total)
echo "📤 Uploading backtest results..."
if [ -d "$BACKEND_DIR/static/backtest_results" ]; then
    scp -r $BACKEND_DIR/static/backtest_results/* $SERVER:/opt/algotcha/backtest_results/
else
    echo "  No backtest results found, skipping"
fi

# Step 6: Ask about parquet files (large - ~45GB)
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 PARQUET DATA FILES"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "The parquet data files are ~45GB and will take a long time to upload."
echo ""
read -p "Do you want to upload parquet files now? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "📤 Uploading parquet files (this will take a while)..."
    
    if [ -d "$BACKEND_DIR/static" ]; then
        # Count parquet files
        PARQUET_COUNT=$(ls $BACKEND_DIR/static/*.parquet 2>/dev/null | wc -l | xargs)
        
        if [ "$PARQUET_COUNT" -gt 0 ]; then
            echo "Found $PARQUET_COUNT parquet files to upload"
            
            # Use rsync if available (faster, resumable)
            if command -v rsync &> /dev/null; then
                echo "Using rsync for faster transfer..."
                rsync -avz --progress $BACKEND_DIR/static/*.parquet $SERVER:/opt/algotcha/data/
            else
                echo "Using scp..."
                for file in $BACKEND_DIR/static/*.parquet; do
                    if [ -f "$file" ]; then
                        filename=$(basename "$file")
                        echo "   Uploading $filename..."
                        scp "$file" $SERVER:/opt/algotcha/data/
                    fi
                done
            fi
        else
            echo "No parquet files found in $BACKEND_DIR/static/"
        fi
    else
        echo "Static directory not found"
    fi
else
    echo "Skipping parquet upload. You can upload them later with:"
    echo "  rsync -avz --progress $BACKEND_DIR/static/*.parquet $SERVER:/opt/algotcha/data/"
fi

echo ""
echo "=========================================="
echo "  UPLOAD COMPLETE!"
echo "=========================================="
echo ""
echo "Next steps on server:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. SSH to server:"
echo "   ssh $SERVER"
echo ""
echo "2. Setup Python environment:"
echo "   apt update && apt install -y python3 python3-pip python3-venv redis-server"
echo "   cd /opt/algotcha && python3 -m venv venv"
echo "   source venv/bin/activate"
echo "   pip install ccxt pandas numpy ta pyarrow fastparquet flask gunicorn redis"
echo ""
echo "3. Configure and start service:"
echo "   nano /etc/systemd/system/algotcha-data.service"
echo "   # Change ALGOTCHA_API_KEY to a secure random string"
echo "   systemctl daemon-reload"
echo "   systemctl enable algotcha-data"
echo "   systemctl start algotcha-data"
echo ""
echo "4. Setup cron for minute updates:"
echo "   crontab -e"
echo "   # Add: * * * * * /opt/algotcha/venv/bin/python /opt/algotcha/scripts/minute_update.py >> /opt/algotcha/logs/cron.log 2>&1"
echo ""
echo "5. Test the server:"
echo "   curl http://localhost:5000/health"
echo ""
echo "Or run the inspection script:"
echo "   bash /tmp/inspect_contabo.sh"
echo ""

