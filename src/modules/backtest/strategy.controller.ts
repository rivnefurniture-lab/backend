import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

@Controller('strategy')
export class StrategyController {
  constructor(private readonly strategyService: StrategyService) {}

  // ==================== STRATEGY MANAGEMENT ====================

  @UseGuards(JwtAuthGuard)
  @Post('create')
  async createStrategy(@Req() req: any, @Body() body: any) {
    // For now, use a demo user ID since auth is not fully set up
    const userId = req.user?.sub ? parseInt(req.user.sub) : 1;
    return this.strategyService.createStrategy(userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('list')
  async listStrategies(@Req() req: any) {
    const userId = req.user?.sub ? parseInt(req.user.sub) : 1;
    return this.strategyService.getUserStrategies(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async getStrategy(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.sub ? parseInt(req.user.sub) : 1;
    return this.strategyService.getStrategy(parseInt(id), userId);
  }

  @UseGuards(JwtAuthGuard)
  @Put(':id')
  async updateStrategy(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    const userId = req.user?.sub ? parseInt(req.user.sub) : 1;
    return this.strategyService.updateStrategy(parseInt(id), userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async deleteStrategy(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.sub ? parseInt(req.user.sub) : 1;
    return this.strategyService.deleteStrategy(parseInt(id), userId);
  }

  // ==================== LIVE TRADING ====================

  @UseGuards(JwtAuthGuard)
  @Post(':id/start')
  async startStrategy(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { initialBalance?: number },
  ) {
    const userId = req.user?.sub ? parseInt(req.user.sub) : 1;
    return this.strategyService.startStrategyRun(
      parseInt(id),
      userId,
      body.initialBalance,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/stop')
  async stopStrategy(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.sub ? parseInt(req.user.sub) : 1;
    return this.strategyService.stopStrategyRun(parseInt(id), userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('running/all')
  async getRunningStrategies(@Req() req: any) {
    const userId = req.user?.sub ? parseInt(req.user.sub) : 1;
    return this.strategyService.getRunningStrategies(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/history')
  async getRunHistory(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.sub ? parseInt(req.user.sub) : 1;
    return this.strategyService.getStrategyRunHistory(parseInt(id), userId);
  }

  // ==================== SAVE FROM BACKTEST ====================

  @UseGuards(JwtAuthGuard)
  @Post('save-from-backtest')
  async saveFromBacktest(@Req() req: any, @Body() body: any) {
    const userId = req.user?.sub ? parseInt(req.user.sub) : 1;
    return this.strategyService.saveBacktestAsStrategy(userId, body);
  }

  // ==================== DASHBOARD ====================

  @UseGuards(JwtAuthGuard)
  @Get('dashboard/stats')
  async getDashboardStats(@Req() req: any) {
    const userId = req.user?.sub ? parseInt(req.user.sub) : 1;
    return this.strategyService.getDashboardStats(userId);
  }

  // ==================== PUBLIC DEMO ENDPOINTS ====================

  @Post('demo/create')
  async demoCreateStrategy(@Body() body: any) {
    return this.strategyService.createStrategy(1, body);
  }

  @Get('demo/list')
  async demoListStrategies() {
    return this.strategyService.getUserStrategies(1);
  }

  @Post('demo/save-from-backtest')
  async demoSaveFromBacktest(@Body() body: any) {
    return this.strategyService.saveBacktestAsStrategy(1, body);
  }

  @Get('demo/dashboard')
  async demoDashboard() {
    return this.strategyService.getDashboardStats(1);
  }
}
