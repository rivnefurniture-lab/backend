// TODO: register and chose plan https://sendgrid.com/en-us/pricing
// TODO: Update with your own key https://myaccount.google.com/apppasswords
import nodemailer, { SentMessageInfo, Transporter } from 'nodemailer';

const {
  SMTP_ENABLED,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  GMAIL_EMAIL,
  GMAIL_PASS,
  FROM_EMAIL,
  NEXT_PUBLIC_APP_URL,
  NODE_ENV,
} = process.env;

let transporter: Transporter<SentMessageInfo>;

if (SMTP_ENABLED === 'true') {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  if (NODE_ENV !== 'production') {
    console.log('MailService using SMTP transport');
  }
} else {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_EMAIL,
      pass: GMAIL_PASS,
    },
  });
  if (NODE_ENV !== 'production') {
    console.log('MailService using Gmail transport');
  }
}

export async function sendVerificationEmail(
  to: string,
  token: string,
): Promise<SentMessageInfo> {
  const verifyUrl = `${NEXT_PUBLIC_APP_URL}/auth/verify-email?token=${token}`;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const info = await transporter.sendMail({
    from: FROM_EMAIL || GMAIL_EMAIL || '"No Reply" <no-reply@example.com>',
    to,
    subject: 'Verify your email',
    html: `
      <p>Hi,</p>
      <p>Thank you for registering. Please verify your email by clicking the link below:</p>
      <a href="${verifyUrl}">Verify Email</a>
      <p>If you did not register, you can ignore this email.</p>
    `,
  });

  if (NODE_ENV !== 'production') {
    console.log(`Verification email sent`);
  }

  return info;
}

export async function sendPasswordResetEmail(
  to: string,
  token: string,
): Promise<SentMessageInfo> {
  const resetUrl = `${NEXT_PUBLIC_APP_URL}/auth/reset-password?token=${token}`;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const info = await transporter.sendMail({
    from: FROM_EMAIL || GMAIL_EMAIL || '"No Reply" <no-reply@example.com>',
    to,
    subject: 'Reset your password',
    html: `
      <p>Hi,</p>
      <p>You requested a password reset. Click the link below to reset your password:</p>
      <a href="${resetUrl}">Reset Password</a>
      <p>If you did not request this, you can ignore this email.</p>
    `,
  });

  if (NODE_ENV !== 'production') {
    console.log(`Password reset email sent`);
  }

  return info;
}
