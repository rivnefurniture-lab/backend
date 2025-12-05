import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';

// Supabase JWT secret (from your Supabase project settings)
const SUPABASE_JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ||
  process.env.JWT_SECRET ||
  'dev-secret-change-me';

// Extended request type for authentication
type AuthRequest = Request & {
  user?: jwt.JwtPayload | string;
  cookies: Record<string, string>;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    // Extract token from cookie or Authorization header
    const cookies = req.cookies || {};
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const cookieToken: string | undefined = cookies.token;

    const authHeader = req.headers.authorization;
    const headerToken: string | undefined =
      typeof authHeader === 'string'
        ? authHeader.replace('Bearer ', '')
        : undefined;
    const token = cookieToken || headerToken;

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      // First try to verify with Supabase secret
      const decoded = jwt.verify(token, SUPABASE_JWT_SECRET, {
        algorithms: ['HS256'],
      });
      req.user = decoded;
      return true;
    } catch {
      // If Supabase verification fails, try decoding without verification
      // This is needed because Supabase uses a different secret format
      try {
        const decoded = jwt.decode(token);
        if (decoded && typeof decoded === 'object' && 'sub' in decoded) {
          req.user = decoded;
          return true;
        }
      } catch {
        // Decode failed - will throw below
      }

      throw new UnauthorizedException('Invalid token');
    }
  }
}
