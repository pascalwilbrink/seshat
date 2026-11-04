import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { type HealthReport, HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  async check(): Promise<HealthReport> {
    const report = await this.health.check();
    if (report.status === 'error') throw new ServiceUnavailableException(report);
    return report;
  }
}
