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
  ADMIN_EMAIL,
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

export async function sendRefundAdminEmail(
  userEmail: string,
  reason: string,
  refundId: number,
): Promise<SentMessageInfo | null> {
  const adminTo = ADMIN_EMAIL || GMAIL_EMAIL;
  if (!adminTo) {
    console.warn('No ADMIN_EMAIL configured — skipping refund notification');
    return null;
  }

  const from = FROM_EMAIL || GMAIL_EMAIL || '"Algotcha" <no-reply@algotcha.com>';
  const info = await transporter.sendMail({
    from,
    to: adminTo,
    subject: `[Algotcha] New Refund Request #${refundId}`,
    html: `
      <h2>New Refund Request</h2>
      <p><strong>User:</strong> ${userEmail}</p>
      <p><strong>Reason:</strong> ${reason}</p>
      <p><strong>Request ID:</strong> ${refundId}</p>
      <p><a href="${NEXT_PUBLIC_APP_URL || 'https://algotcha.com'}/admin">Review in Admin Panel</a></p>
    `,
  });

  if (NODE_ENV !== 'production') {
    console.log('Refund admin email sent to', adminTo);
  }

  return info;
}
