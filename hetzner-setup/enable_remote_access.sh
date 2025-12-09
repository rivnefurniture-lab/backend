#!/bin/bash
# Master script to enable full remote access to Contabo server
# Combines firewall configuration and SSH setup

echo "=========================================="
echo "  ENABLING REMOTE ACCESS TO CONTABO"
echo "  Server: 154.91.86.94"
echo "=========================================="
echo ""

# Step 1: Configure SSH
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "STEP 1: Configuring SSH"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Backup SSH config
if [ ! -f /etc/ssh/sshd_config.backup ]; then
    cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup
    echo "✓ SSH config backed up"
fi

# Enable password authentication
if grep -q "^PasswordAuthentication" /etc/ssh/sshd_config; then
    sed -i 's/^PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
else
    echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config
fi

# Enable root login
if grep -q "^PermitRootLogin" /etc/ssh/sshd_config; then
    sed -i 's/^PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
else
    echo "PermitRootLogin yes" >> /etc/ssh/sshd_config
fi

# Ensure port 22
if grep -q "^Port" /etc/ssh/sshd_config; then
    sed -i 's/^Port.*/Port 22/' /etc/ssh/sshd_config
fi

echo "✓ SSH configured for password authentication"
echo "✓ Root login enabled"

# Restart SSH
systemctl restart sshd 2>/dev/null || systemctl restart ssh
echo "✓ SSH service restarted"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "STEP 2: Configuring Firewall"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Install UFW if needed
if ! command -v ufw &> /dev/null; then
    echo "Installing UFW..."
    apt update -qq
    apt install -y ufw
fi

# Configure firewall rules
echo "✓ Configuring firewall rules..."

# Allow SSH FIRST (critical!)
ufw allow 22/tcp 2>/dev/null
ufw allow ssh 2>/dev/null

# Allow other ports
ufw allow 5000/tcp 2>/dev/null  # Algotcha data server
ufw allow 80/tcp 2>/dev/null    # HTTP
ufw allow 443/tcp 2>/dev/null   # HTTPS

# Set default policies
ufw --force default deny incoming
ufw --force default allow outgoing

# Enable firewall
echo "y" | ufw --force enable

echo "✓ Firewall configured and enabled"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "STEP 3: Verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Get public IP
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo "Public IP: $PUBLIC_IP"
echo ""

# Show firewall status
echo "Firewall status:"
ufw status | head -20
echo ""

# Show SSH config
echo "SSH configuration:"
grep -E "^(Port|PasswordAuthentication|PermitRootLogin)" /etc/ssh/sshd_config
echo ""

# Show listening ports
echo "Listening ports:"
ss -tulpn | grep LISTEN | grep -E ":(22|5000|80|443)" || echo "No services listening yet"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ REMOTE ACCESS ENABLED!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Your server is now accessible via:"
echo "  ssh root@$PUBLIC_IP"
echo ""
echo "Ports opened:"
echo "  ✓ 22   - SSH"
echo "  ✓ 80   - HTTP"
echo "  ✓ 443  - HTTPS"
echo "  ✓ 5000 - Algotcha Data Server"
echo ""
echo "⚠️  IMPORTANT:"
echo "  1. Test SSH connection from another terminal"
echo "  2. Check Contabo control panel for cloud firewall"
echo "  3. Keep this terminal open until you verify access"
echo ""
echo "Test connection with:"
echo "  ssh root@$PUBLIC_IP"
echo ""

