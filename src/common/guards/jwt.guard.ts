import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token =
      req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
    if (!token) throw new UnauthorizedException('Unauthorized');
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      return true;
    } catch {
      throw new UnauthorizedException('Unauthorized');
    }
  }
}
