import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class NotificationService {
  private readonly telegramToken = process.env.TELEGRAM_BOT_TOKEN || '8573074509:AAHDMYFF0WM6zSGkkhKHVNLTypxbw';
  private readonly emailTransporter: nodemailer.Transporter;

  constructor() {
    // Setup email transporter with Gmail
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.emailTransporter = nodemailer.createTransporter({
      service: 'gmail',
      auth: {
        user: 'o.kytsuk@gmail.com',
        pass: process.env.GMAIL_APP_PASSWORD || 'hvxe tvqo zuhf rdqo',
      },
    });
  }

  async sendTelegramNotification(
    telegramId: string,
    strategyName: string,
    metrics: Record<string, unknown>,
    status: 'completed' | 'failed',
    error?: string,
  ) {
    if (!telegramId) {
      return;
    }

    let message = '';

    if (status === 'completed') {
      message = `
🎉 *Backtest Complete!*

📊 *Strategy:* ${strategyName}

*Results:*
💰 Net Profit: ${metrics.net_profit_usd}
📈 Total Return: ${metrics.net_profit?.toFixed(2)}%
📉 Max Drawdown: ${metrics.max_drawdown?.toFixed(2)}%
🎯 Win Rate: ${(metrics.win_rate * 100)?.toFixed(2)}%
💼 Total Trades: ${metrics.total_trades}
🏆 Profit Factor: ${metrics.profit_factor?.toFixed(2)}x
📊 Sharpe Ratio: ${metrics.sharpe_ratio?.toFixed(2)}

✅ View detailed results in your Algotcha dashboard!
      `.trim();
    } else {
      message = `
❌ *Backtest Failed*

📊 *Strategy:* ${strategyName}

*Error:* ${error || 'Unknown error occurred'}

Please try again or contact support if the issue persists.
      `.trim();
    }

    const url = `https://api.telegram.org/bot${this.telegramToken}/sendMessage`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramId,
          text: message,
          parse_mode: 'Markdown',
        }),
      });

      if (!response.ok) {
        console.error('Telegram API error:', await response.text());
      }
    } catch (error) {
      console.error('Failed to send Telegram notification:', error);
    }
  }

  async sendEmailNotification(
    email: string,
    strategyName: string,
    metrics: Record<string, unknown>,
    status: 'completed' | 'failed',
    error?: string,
  ) {
    if (!email) {
      return;
    }

    let subject = '';
    let html = '';

    if (status === 'completed') {
      subject = `✅ Backtest Complete - ${strategyName}`;
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10b981;">🎉 Backtest Complete!</h2>
          
          <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">📊 Strategy: ${strategyName}</h3>
            
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0;"><strong>💰 Net Profit:</strong></td>
                <td style="text-align: right;">${metrics.net_profit_usd}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0;"><strong>📈 Total Return:</strong></td>
                <td style="text-align: right;">${metrics.net_profit?.toFixed(2)}%</td>
              </tr>
              <tr>
                <td style="padding: 8px 0;"><strong>📉 Max Drawdown:</strong></td>
                <td style="text-align: right;">${metrics.max_drawdown?.toFixed(2)}%</td>
              </tr>
              <tr>
                <td style="padding: 8px 0;"><strong>🎯 Win Rate:</strong></td>
                <td style="text-align: right;">${(metrics.win_rate * 100)?.toFixed(2)}%</td>
              </tr>
              <tr>
                <td style="padding: 8px 0;"><strong>💼 Total Trades:</strong></td>
                <td style="text-align: right;">${metrics.total_trades}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0;"><strong>🏆 Profit Factor:</strong></td>
                <td style="text-align: right;">${metrics.profit_factor?.toFixed(2)}x</td>
              </tr>
              <tr>
                <td style="padding: 8px 0;"><strong>📊 Sharpe Ratio:</strong></td>
                <td style="text-align: right;">${metrics.sharpe_ratio?.toFixed(2)}</td>
              </tr>
            </table>
          </div>
          
          <p><a href="https://algotcha.com/backtest" style="display: inline-block; background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 10px;">View Details</a></p>
          
          <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
            This is an automated message from Algotcha. Visit your dashboard to see detailed results.
          </p>
        </div>
      `;
    } else {
      subject = `❌ Backtest Failed - ${strategyName}`;
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #ef4444;">❌ Backtest Failed</h2>
          
          <div style="background: #fee2e2; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">📊 Strategy: ${strategyName}</h3>
            <p><strong>Error:</strong> ${error || 'Unknown error occurred'}</p>
          </div>
          
          <p>Please try again or contact our support team if the issue persists.</p>
          
          <p><a href="https://algotcha.com/support" style="display: inline-block; background: #ef4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 10px;">Contact Support</a></p>
        </div>
      `;
    }

    try {
      await this.emailTransporter.sendMail({
        from: '"Algotcha" <o.kytsuk@gmail.com>',
        to: email,
        subject,
        html,
      });
    } catch (error) {
      console.error('Failed to send email notification:', error);
    }
  }

  async notifyUser(
    notifyVia: string,
    email: string,
    telegramId: string | null,
    strategyName: string,
    metrics: Record<string, unknown>,
    status: 'completed' | 'failed',
    error?: string,
  ) {
    const promises: Promise<void>[] = [];

    if (notifyVia === 'email' || notifyVia === 'both') {
      promises.push(
        this.sendEmailNotification(email, strategyName, metrics, status, error),
      );
    }

    if ((notifyVia === 'telegram' || notifyVia === 'both') && telegramId) {
      promises.push(
        this.sendTelegramNotification(telegramId, strategyName, metrics, status, error),
      );
    }

    await Promise.all(promises);
  }
}

