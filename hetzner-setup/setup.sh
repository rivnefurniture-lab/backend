#!/bin/bash
# Algotcha Trading Server Setup Script
# Run this on your Hetzner server

set -e

echo "=========================================="
echo "  ALGOTCHA TRADING SERVER SETUP"
echo "=========================================="

# Update system
echo "📦 Updating system packages..."
apt update && apt upgrade -y

# Install dependencies
echo "📦 Installing dependencies..."
apt install -y python3 python3-pip python3-venv nodejs npm git curl htop screen

# Create app directory
echo "📁 Creating application directory..."
mkdir -p /opt/algotcha
cd /opt/algotcha

# Create Python virtual environment
echo "🐍 Setting up Python environment..."
python3 -m venv venv
source venv/bin/activate

# Install Python packages
echo "📦 Installing Python packages..."
pip install --upgrade pip
pip install ccxt pandas numpy ta pyarrow fastparquet flask gunicorn

# Create directories
mkdir -p data scripts logs

echo "✅ Base setup complete!"
echo ""
echo "Next steps:"
echo "1. Upload your fetcher script to /opt/algotcha/scripts/"
echo "2. Upload parquet files to /opt/algotcha/data/"
echo "3. Run: source /opt/algotcha/venv/bin/activate"
echo "4. Start the services"

