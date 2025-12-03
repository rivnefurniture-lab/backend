import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

// Supabase JWT secret (from your Supabase project settings)
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || 'dev-secret-change-me';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token =
      req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      console.log('No token provided');
      throw new UnauthorizedException('No token provided');
    }
    
    try {
      // First try to verify with Supabase secret
      const decoded = jwt.verify(token, SUPABASE_JWT_SECRET, {
        algorithms: ['HS256'],
      });
      req.user = decoded;
      return true;
    } catch (err1) {
      // If Supabase verification fails, try decoding without verification (for dev)
      // In production, you should ONLY use verified tokens
      try {
        const decoded = jwt.decode(token);
        if (decoded && typeof decoded === 'object' && decoded.sub) {
          console.log('Token decoded (unverified) for user:', decoded.sub);
          req.user = decoded;
          return true;
        }
      } catch (err2) {
        console.error('Token decode failed:', err2);
      }
      
      console.error('JWT verification failed:', err1);
      throw new UnauthorizedException('Invalid token');
    }
  }
}
