import {
  Controller,
  Get,
  Post,
  Body,
  Header,
  HttpException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { HetznerService } from './modules/hetzner/hetzner.service';

@ApiTags('Health')
@Controller()
export class HealthController {
  private readonly supabaseUrl = 'https://amchsdenmcbdpaoamoie.supabase.co';
  private readonly supabaseKey =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFtY2hzZGVubWNiZHBhb2Ftb2llIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk3NjA1MjcsImV4cCI6MjA3NTMzNjUyN30.tHWks2yIwBCFqQhAHTqv3Jycr_XB48aRVY4tOuBsHas';

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
    console.log('Proxy login attempt for:', body.email);

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
    console.log('Supabase response status:', response.status);

    if (!response.ok) {
      // Return Supabase error directly to client
      const errorData = data as {
        msg?: string;
        error_description?: string;
        error?: string;
      };
      throw new HttpException(
        {
          message:
            errorData.msg ||
            errorData.error_description ||
            'Authentication failed',
          error: errorData.error || 'auth_error',
          statusCode: response.status,
        },
        response.status,
      );
    }

    return data;
  }

  @Post('auth/proxy/register')
  @ApiOperation({ summary: 'Proxy register to Supabase' })
  async proxyRegister(@Body() body: { email: string; password: string }) {
    console.log('Proxy register attempt for:', body.email);

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
    console.log('Supabase register response status:', response.status);

    if (!response.ok) {
      const errorData = data as {
        msg?: string;
        error_description?: string;
        error?: string;
      };
      throw new HttpException(
        {
          message:
            errorData.msg ||
            errorData.error_description ||
            'Registration failed',
          error: errorData.error || 'register_error',
          statusCode: response.status,
        },
        response.status,
      );
    }

    return data;
  }

  @Post('auth/proxy/reset')
  @ApiOperation({ summary: 'Proxy password reset to Supabase' })
  async proxyReset(@Body() body: { email: string }) {
    console.log('Proxy reset attempt for:', body.email);

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
    console.log('Supabase reset response status:', response.status);

    if (!response.ok) {
      const errorData = data as {
        msg?: string;
        error_description?: string;
        error?: string;
      };
      throw new HttpException(
        {
          message:
            errorData.msg ||
            errorData.error_description ||
            'Password reset failed',
          error: errorData.error || 'reset_error',
          statusCode: response.status,
        },
        response.status,
      );
    }

    return data;
  }
}
