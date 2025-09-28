import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { sign as jwtSign } from 'jsonwebtoken';
import * as crypto from 'crypto';
import { UserDto } from './dto/user.dto';
import { RegisterDto } from './dto/register.dto';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

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
    if (exists) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(data.password, 10);

    const user = await this.prisma.client.user.create({
      data: {
        email,
        passwordHash,
        name: data.name ?? null,
        phone: data.phone ?? null,
        country: data.country ?? null,
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

    return user;
  }

  // Login
  async login(email: string, password: string): Promise<UserDto> {
    const user = await this.prisma.client.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');

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

  // Get me
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
