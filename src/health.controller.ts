import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Health')
@Controller()
export class HealthController {
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
  health() {
    return {
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
    };
  }

  @Get('ping')
  @Header('Content-Type', 'text/plain')
  @ApiOperation({ summary: 'Simple ping endpoint' })
  ping() {
    return 'pong';
  }
}

