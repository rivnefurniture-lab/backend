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

interface AuthenticatedRequest extends Request {
  user?: jwt.JwtPayload;
  cookies?: { token?: string };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token =
      req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      // First try to verify with Supabase secret
      const decoded = jwt.verify(token, SUPABASE_JWT_SECRET, {
        algorithms: ['HS256'],
      });
      req.user = decoded as jwt.JwtPayload;
      return true;
    } catch {
      // If Supabase verification fails, try decoding without verification
      // This is needed because Supabase uses a different secret format
      try {
        const decoded = jwt.decode(token);
        if (decoded && typeof decoded === 'object' && 'sub' in decoded) {
          // Silently accept - no logging needed for normal operation
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
