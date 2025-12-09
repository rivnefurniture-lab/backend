#!/bin/bash
# Open firewall for remote access to Contabo server
# This will allow external connections for management

echo "=========================================="
echo "  OPENING FIREWALL FOR REMOTE ACCESS"
echo "=========================================="
echo ""

# Check if UFW is installed
if ! command -v ufw &> /dev/null; then
    echo "📦 Installing UFW..."
    apt update
    apt install -y ufw
fi

echo "🔓 Configuring firewall rules..."
echo ""

# Allow SSH (port 22) - CRITICAL!
echo "✓ Allowing SSH (port 22)..."
ufw allow 22/tcp
ufw allow ssh

# Allow data server (port 5000)
echo "✓ Allowing data server (port 5000)..."
ufw allow 5000/tcp

# Allow common ports
echo "✓ Allowing HTTP (port 80)..."
ufw allow 80/tcp

echo "✓ Allowing HTTPS (port 443)..."
ufw allow 443/tcp

# Set default policies
echo ""
echo "📋 Setting default policies..."
ufw default deny incoming
ufw default allow outgoing

# Enable UFW (with --force to avoid interactive prompt)
echo ""
echo "🔥 Enabling firewall..."
echo "y" | ufw enable

echo ""
echo "✅ Firewall configured!"
echo ""

# Show status
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Current Firewall Status:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ufw status verbose

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🌐 Network Configuration:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Public IP: $(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo "Hostname: $(hostname)"
echo ""
echo "Listening ports:"
netstat -tulpn 2>/dev/null | grep LISTEN || ss -tulpn | grep LISTEN

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔑 SSH Configuration Check:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check SSH configuration
if [ -f /etc/ssh/sshd_config ]; then
    echo "PasswordAuthentication: $(grep -E "^PasswordAuthentication" /etc/ssh/sshd_config || echo "not set (default: yes)")"
    echo "PermitRootLogin: $(grep -E "^PermitRootLogin" /etc/ssh/sshd_config || echo "not set (default: prohibit-password)")"
    echo "Port: $(grep -E "^Port" /etc/ssh/sshd_config || echo "not set (default: 22)")"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ FIREWALL OPENED SUCCESSFULLY!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Ports now open:"
echo "  • 22   (SSH)"
echo "  • 80   (HTTP)"
echo "  • 443  (HTTPS)"
echo "  • 5000 (Algotcha Data Server)"
echo ""
echo "⚠️  SECURITY NOTE:"
echo "Your server is now accessible from the internet."
echo "Make sure to:"
echo "  1. Use strong passwords"
echo "  2. Consider setting up SSH key authentication"
echo "  3. Keep software updated"
echo "  4. Monitor access logs regularly"
echo ""

