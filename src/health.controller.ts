import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { HetznerService } from './modules/hetzner/hetzner.service';

@ApiTags('Health')
@Controller()
export class HealthController {
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
      }
    };
  }

  @Get('ping')
  @Header('Content-Type', 'text/plain')
  @ApiOperation({ summary: 'Simple ping endpoint' })
  ping() {
    return 'pong';
  }
}

