import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

// Supabase Proxy Controller - Forwards auth requests to Supabase
@Controller('api/supabase-proxy')
export class SupabaseProxyController {
  private readonly supabaseUrl = 'https://amchsdenmcbdpaoamoie.supabase.co';
  private readonly supabaseKey =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFtY2hzZGVubWNiZHBhb2Ftb2llIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk3NjA1MjcsImV4cCI6MjA3NTMzNjUyN30.tHWks2yIwBCFqQhAHTqv3Jycr_XB48aRVY4tOuBsHas';

  @Post('login')
  async login(@Body() body: { email: string; password: string }) {
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
      console.error('Supabase proxy error:', error);
      throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('register')
  async register(@Body() body: { email: string; password: string }) {
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
      console.error('Supabase proxy error:', error);
      throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('reset-password')
  async resetPassword(@Body() body: { email: string }) {
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
      console.error('Supabase proxy error:', error);
      throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
