import {
  Controller,
  Get,
  Post,
  Body,
  Header,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { HetznerService } from './modules/hetzner/hetzner.service';

@ApiTags('Health')
@Controller()
export class HealthController {
  private readonly supabaseUrl = 'https://kgjxftjkxbdzzlsgohds.supabase.co';
  private readonly supabaseKey =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtnanhmdGpreGJkenpsc2dvaGRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzMzMzE5MjIsImV4cCI6MjA0ODkwNzkyMn0.ApcKqvqmjbvD12Ys7r6c4EATNnXvb-rINrpvJjO-rTE';

  constructor(private readonly hetzner: HetznerService) {}

  @Get()
  @Header('Content-Type', 'application/json')
  @ApiOperation({ summary: 'Root endpoint' })
  root() {
    return {
      name: 'Algotcha API',
      version: '2.0.0',
      status: 'running',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('health')
  @Header('Content-Type', 'application/json')
  @ApiOperation({ summary: 'Health check endpoint' })
  async health() {
    const hetznerHealthy = await this.hetzner.isHealthy();
    const hetznerStatus = await this.hetzner.getDataStatus();

    return {
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      dataServer: {
        connected: hetznerHealthy,
        url: process.env.HETZNER_DATA_URL || 'http://46.224.99.27:5000',
        files: hetznerStatus.fileCount,
        hasData: hetznerStatus.hasData,
      },
    };
  }

  @Get('ping')
  @Header('Content-Type', 'text/plain')
  @ApiOperation({ summary: 'Simple ping endpoint' })
  ping() {
    return 'pong';
  }

  // Supabase Proxy Endpoints for Mobile App
  @Post('auth/proxy/login')
  @ApiOperation({ summary: 'Proxy login to Supabase' })
  async proxyLogin(@Body() body: { email: string; password: string }) {
    try {
      const response = await fetch(
        `${this.supabaseUrl}/auth/v1/token?grant_type=password`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: this.supabaseKey,
          },
          body: JSON.stringify({
            email: body.email,
            password: body.password,
          }),
        },
      );

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        throw new HttpException(data, response.status);
      }

      return data;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Authentication failed';
      throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('auth/proxy/register')
  @ApiOperation({ summary: 'Proxy register to Supabase' })
  async proxyRegister(@Body() body: { email: string; password: string }) {
    try {
      const response = await fetch(`${this.supabaseUrl}/auth/v1/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.supabaseKey,
        },
        body: JSON.stringify({
          email: body.email,
          password: body.password,
        }),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        throw new HttpException(data, response.status);
      }

      return data;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Registration failed';
      throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('auth/proxy/reset')
  @ApiOperation({ summary: 'Proxy password reset to Supabase' })
  async proxyReset(@Body() body: { email: string }) {
    try {
      const response = await fetch(`${this.supabaseUrl}/auth/v1/recover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.supabaseKey,
        },
        body: JSON.stringify({
          email: body.email,
        }),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        throw new HttpException(data, response.status);
      }

      return data;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Password reset failed';
      throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
