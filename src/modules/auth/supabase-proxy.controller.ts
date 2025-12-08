import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

@Controller('api/supabase-proxy')
export class SupabaseProxyController {
  private readonly supabaseUrl = 'https://kgjxftjkxbdzzlsgohds.supabase.co';
  private readonly supabaseKey =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtnanhmdGpreGJkenpsc2dvaGRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzMzMzE5MjIsImV4cCI6MjA0ODkwNzkyMn0.ApcKqvqmjbvD12Ys7r6c4EATNnXvb-rINrpvJjO-rTE';

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
