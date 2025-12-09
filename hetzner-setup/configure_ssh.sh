#!/bin/bash
# Configure SSH for password authentication and root login
# This ensures remote access is properly configured

echo "=========================================="
echo "  CONFIGURING SSH ACCESS"
echo "=========================================="
echo ""

# Backup original SSH config
if [ ! -f /etc/ssh/sshd_config.backup ]; then
    echo "📦 Backing up SSH config..."
    cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup
    echo "✓ Backup created at /etc/ssh/sshd_config.backup"
fi

echo ""
echo "🔧 Configuring SSH settings..."

# Enable password authentication
if grep -q "^PasswordAuthentication" /etc/ssh/sshd_config; then
    sed -i 's/^PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
else
    echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config
fi
echo "✓ Password authentication enabled"

# Enable root login
if grep -q "^PermitRootLogin" /etc/ssh/sshd_config; then
    sed -i 's/^PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
else
    echo "PermitRootLogin yes" >> /etc/ssh/sshd_config
fi
echo "✓ Root login enabled"

# Make sure SSH is on port 22
if grep -q "^Port" /etc/ssh/sshd_config; then
    sed -i 's/^Port.*/Port 22/' /etc/ssh/sshd_config
else
    echo "Port 22" >> /etc/ssh/sshd_config
fi
echo "✓ SSH port set to 22"

# Restart SSH service
echo ""
echo "🔄 Restarting SSH service..."
systemctl restart sshd || systemctl restart ssh

if systemctl is-active --quiet sshd || systemctl is-active --quiet ssh; then
    echo "✓ SSH service restarted successfully"
else
    echo "⚠️  SSH service restart failed - please check manually"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Current SSH Configuration:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
grep -E "^(Port|PasswordAuthentication|PermitRootLogin)" /etc/ssh/sshd_config

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ SSH CONFIGURED SUCCESSFULLY!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "SSH is now accepting:"
echo "  • Password authentication: YES"
echo "  • Root login: YES"
echo "  • Port: 22"
echo ""
echo "You can now connect via:"
echo "  ssh root@$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo ""

