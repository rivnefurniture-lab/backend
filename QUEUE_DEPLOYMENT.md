# Algotcha Backtest Queue System - Deployment Guide

## 🎯 Overview

The backtest queue system allows multiple users to run backtests simultaneously by queuing them and processing one at a time. Users can choose to receive results via Telegram or Email.

## 📦 Components

1. **Backend Services** (NestJS):
   - `QueueService` - Manages the backtest queue
   - `NotificationService` - Sends Telegram/Email notifications
   - Updated `BacktestController` - Queue endpoints

2. **Worker** (Python on Contabo):
   - `backtest_worker.py` - Processes backtests from queue
   - Runs as systemd service

3. **Database**:
   - New `BacktestQueue` table in PostgreSQL

4. **Frontend**:
   - Queue position dialog
   - Notification preference selector

## 🚀 Deployment Steps

### Step 1: Update Database Schema

```bash
cd backend
npx prisma migrate dev --name add_backtest_queue
npx prisma generate
```

### Step 2: Deploy Backend Code

Push updated code to Railway:
```bash
git add backend/prisma/schema.prisma
git add backend/src/modules/backtest/
git commit -m "Add backtest queue system"
git push railway main
```

Update environment variables on Railway:
- `DATABASE_URL` - Already configured
- `TELEGRAM_BOT_TOKEN` - `8573074509:AAHDMYFF0WM6zSGkkhKHVNLTypxbw`
- `GMAIL_APP_PASSWORD` - `hvxe tvqo zuhf rdqo`

### Step 3: Deploy Worker to Contabo

```bash
# Upload worker script
scp backend/hetzner-setup/backtest_worker.py root@144.91.86.94:/opt/algotcha/scripts/

# Upload systemd service file
scp backend/hetzner-setup/backtest-worker.service root@144.91.86.94:/etc/systemd/system/

# SSH to Contabo
ssh root@144.91.86.94

# Update DATABASE_URL in service file
nano /etc/systemd/system/backtest-worker.service
# Replace USER, PASSWORD, HOST, PORT, DATABASE with actual values

# Make worker executable
chmod +x /opt/algotcha/scripts/backtest_worker.py

# Install Python dependencies (if not already installed)
pip3 install psycopg2-binary requests

# Start and enable service
systemctl daemon-reload
systemctl enable backtest-worker
systemctl start backtest-worker

# Check status
systemctl status backtest-worker

# View logs
tail -f /opt/algotcha/logs/backtest_worker.log
```

### Step 4: Update Frontend

The frontend needs a dialog component that:
1. Shows queue position ("You are #3 in line")
2. Asks: "Where do you want to receive results?"
   - ☑️ Email
   - ☑️ Telegram
   - ☑️ Both
3. Submits to `/api/backtest/queue` instead of `/api/backtest/run`

Example API call:
```javascript
const response = await fetch('/api/backtest/queue', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    payload: backtestPayload,  // Same as before
    notifyVia: 'both'  // 'email', 'telegram', or 'both'
  })
});

const result = await response.json();
// result = { success: true, queueId: 123, position: 3, estimatedWait: 45 }
```

## 📡 API Endpoints

### Queue a Backtest
```
POST /api/backtest/queue
Authorization: Bearer {token}
Body: {
  payload: RunBacktestDto,
  notifyVia: 'telegram' | 'email' | 'both'
}
Response: {
  success: true,
  queueId: number,
  position: number,
  estimatedWait: number (minutes)
}
```

### Get Queue Position
```
GET /api/backtest/queue/position/:queueId
Response: {
  id: number,
  status: 'queued' | 'processing' | 'completed' | 'failed',
  queuePosition: number,
  progress: number (0-100)
}
```

### Get My Queue Items
```
GET /api/backtest/queue/my
Response: BacktestQueue[]
```

### Get Queue Statistics
```
GET /api/backtest/queue/stats
Response: {
  queued: number,
  processing: number,
  completed: number,
  totalInQueue: number,
  estimatedWaitMinutes: number
}
```

## 🔔 Notifications

### Telegram
Users need to:
1. Start a chat with your Telegram bot
2. Send `/start`
3. The bot will save their `telegramId` to the database
4. Enable Telegram notifications in their profile

### Email
- Automatically uses the user's registered email
- Gmail SMTP configured with app password

## 🧪 Testing

1. **Test Queue Addition**:
```bash
curl -X POST http://localhost:3000/api/backtest/queue \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {...},
    "notifyVia": "both"
  }'
```

2. **Check Worker Logs**:
```bash
ssh root@144.91.86.94
tail -f /opt/algotcha/logs/backtest_worker.log
```

3. **Monitor Queue**:
```bash
curl http://localhost:3000/api/backtest/queue/stats
```

## 🛠️ Troubleshooting

### Worker Not Processing
```bash
# Check worker status
systemctl status backtest-worker

# Restart worker
systemctl restart backtest-worker

# Check logs
tail -100 /opt/algotcha/logs/backtest_worker.log
```

### Database Connection Issues
- Verify `DATABASE_URL` in service file
- Test connection: `psql $DATABASE_URL`

### Notifications Not Sending
- Verify `TELEGRAM_BOT_TOKEN` is correct
- Verify `GMAIL_APP_PASSWORD` is correct
- Check worker logs for errors

## 📊 Monitoring

### View Queue Status
```sql
SELECT id, "userId", "strategyName", status, 
       "createdAt", "startedAt", "completedAt"
FROM "BacktestQueue"
ORDER BY "createdAt" DESC
LIMIT 20;
```

### View Active Jobs
```sql
SELECT * FROM "BacktestQueue"
WHERE status IN ('queued', 'processing')
ORDER BY "createdAt" ASC;
```

## 🔐 Security

- API endpoints protected with JWT authentication
- Email/Telegram credentials in environment variables only
- Worker runs as root (needs access to data files)
- Database credentials encrypted

## 📝 Notes

- Average backtest takes 10-15 minutes for full period
- Worker processes one backtest at a time
- Queue position updates automatically
- Failed backtests notify user with error message
- Completed backtests saved to database and accessible via dashboard

