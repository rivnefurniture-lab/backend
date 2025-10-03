import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from '../../services/mail.service';
import * as bcrypt from 'bcryptjs';
import { sign as jwtSign, verify as jwtVerify, JwtPayload } from 'jsonwebtoken';
import * as crypto from 'crypto';
import { UserDto } from './dto/user.dto';
import { RegisterDto } from './dto/register.dto';
import { OAuth2Client } from 'google-auth-library';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const OAuth2 = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  sign(payload: Record<string, unknown>) {
    return jwtSign(payload, JWT_SECRET, { expiresIn: '7d' });
  }

  async register(data: RegisterDto): Promise<UserDto> {
    const email = data.email.toLowerCase();

    const exists = await this.prisma.client.user.findUnique({
      where: { email },
    });
    if (exists && !exists.passwordHash) {
      throw new ConflictException(
        'Account exists via Google. Please log in with Google or set a password.',
      );
    }
    if (exists) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(data.password, 10);

    const emailVerifyToken = crypto.randomBytes(32).toString('hex');

    const user = await this.prisma.client.user.create({
      data: {
        email,
        passwordHash,
        name: data.name ?? null,
        phone: data.phone ?? null,
        country: data.country ?? null,
        emailVerifyToken,
        emailVerified: false,
      },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        country: true,
        createdAt: true,
      },
    });

    await sendVerificationEmail(email, emailVerifyToken);

    return user;
  }

  async verifyEmail(
    token: string,
  ): Promise<{ message: string; email: string }> {
    const user = await this.prisma.client.user.findFirst({
      where: { emailVerifyToken: token },
    });

    if (!user) throw new NotFoundException('Invalid token');

    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { emailVerified: true, emailVerifyToken: null },
    });

    return { message: 'Email verified successfully', email: user.email };
  }

  async login(email: string, password: string): Promise<UserDto> {
    const user = await this.prisma.client.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    // Reject users without passwordHash (i.e., Google-only accounts)
    if (!user.passwordHash) {
      throw new UnauthorizedException(
        'This account is registered via Google. Use Google login or set a password.',
      );
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      country: user.country,
      createdAt: user.createdAt,
    };
  }

  async loginWithGoogle(idToken: string): Promise<UserDto> {
    try {
      const ticket = await OAuth2.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();
      if (!payload) throw new UnauthorizedException('Invalid Google token');

      const googleId = payload.sub;
      const email = payload.email;
      const name = payload.name ?? null;

      if (!email)
        throw new UnauthorizedException('Google account has no email');

      let user = await this.prisma.client.user.findUnique({
        where: { googleId },
      });

      if (!user) {
        user = await this.prisma.client.user.findUnique({
          where: { email },
        });
      }

      if (!user) {
        user = await this.prisma.client.user.create({
          data: {
            googleId,
            email,
            name,
          },
        });
      } else if (!user.googleId) {
        // Attach googleId if they signed up earlier with email/password
        user = await this.prisma.client.user.update({
          where: { id: user.id },
          data: { googleId },
        });
      }

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        country: user.country,
        createdAt: user.createdAt,
      };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_) {
      throw new UnauthorizedException('Google login failed');
    }
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.client.user.findUnique({ where: { email } });
    if (!user) {
      return { message: 'If this email exists, a reset link has been sent.' };
    }

    const token = this.sign({ userId: user.id, purpose: 'password-reset' });

    await sendPasswordResetEmail(user.email, token);

    return { message: 'If this email exists, a reset link has been sent.' };
  }

  async resetPassword(token: string, newPassword: string) {
    try {
      const payload = jwtVerify(token, JWT_SECRET) as JwtPayload & {
        userId: number;
        purpose?: string;
      };

      if (payload.purpose !== 'password-reset') {
        throw new UnauthorizedException('Invalid token purpose');
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);

      await this.prisma.client.user.update({
        where: { id: payload.userId },
        data: { passwordHash },
      });

      return { message: 'Password updated successfully' };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_) {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async getMe(userId: number): Promise<UserDto> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        country: true,
        createdAt: true,
        binanceConnectedAt: true,
      },
    });

    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // Optional: encrypt/decrypt for API keys
  private getAesKey(): Buffer {
    return crypto.scryptSync(JWT_SECRET, 'algotcha-salt', 32);
  }

  encryptSecret(plain: string): string {
    const iv = crypto.randomBytes(12);
    const key = this.getAesKey();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${enc.toString('base64')}:${tag.toString('base64')}`;
  }

  decryptSecret(blob: string): string | null {
    if (!blob) return null;
    const [ivb, encb, tagb] = blob.split(':');
    const iv = Buffer.from(ivb, 'base64');
    const enc = Buffer.from(encb, 'base64');
    const tag = Buffer.from(tagb, 'base64');
    const key = this.getAesKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  }
}
