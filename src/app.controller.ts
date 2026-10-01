import { Controller, Get, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { log, sleep } from './log';
import { ShutdownService } from './shutdown.service';

/** Small API whose only purpose is to give the tests something to shut down while busy. */
@Controller()
export class AppController {
  constructor(
    private readonly shutdown: ShutdownService,
    private readonly jobs: JobsService,
  ) {}

  /** Readiness check (what the load balancer calls). 200 normally, 503 during shutdown. */
  @Get('health')
  health() {
    if (this.shutdown.isShuttingDown) throw new ServiceUnavailableException('shutting down');
    return { status: 'ok' };
  }

  /** A slow request. Used to test "in-flight requests must finish". */
  @Get('slow')
  async slow(@Query('ms') ms = '1000') {
    log(`/slow started (${ms}ms)`);
    await sleep(Number(ms));
    log('/slow finished');
    return { done: true };
  }

  /** Queue a background job that takes `ms` milliseconds. */
  @Post('jobs')
  addJob(@Query('ms') ms = '1000', @Query('id') id?: string) {
    return { id: this.jobs.enqueue(Number(ms), id) };
  }

  @Get('stats')
  stats() {
    return this.jobs.stats();
  }
}
