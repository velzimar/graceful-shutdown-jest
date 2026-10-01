import { HttpAdapterHost } from '@nestjs/core';
import type { Server } from 'http';
import {
  BeforeApplicationShutdown,
  Injectable,
  OnApplicationShutdown,
  OnModuleDestroy,
} from '@nestjs/common';
import { config } from './config';
import { JobsService } from './jobs.service';
import { log, sleep } from './log';

/**
 * Everything about shutdown lives here, so the ORDER is visible in one file.
 *
 * ECS stops a container like this:
 *      SIGTERM ──── (stopTimeout, default 30s) ────► SIGKILL (cannot be caught)
 * Everything below must finish before SIGKILL.
 *
 * When SIGTERM arrives, Nest (because of app.enableShutdownHooks()) runs, in order:
 *   [1] onModuleDestroy             → tell the load balancer to stop sending traffic
 *   [2] beforeApplicationShutdown   → stop and drain background jobs
 *       (Nest closes the HTTP server and waits for in-flight requests)
 *   [3] onApplicationShutdown       → close DB / Redis / queues LAST
 *
 * Why this order? Closing the DB first would break the requests and jobs that are
 * still running and need it. Dependencies always close last.
 */
@Injectable()
export class ShutdownService
  implements OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown
{
  private shuttingDown = false;

  constructor(
    private readonly jobs: JobsService,
    private readonly adapterHost: HttpAdapterHost, // gives access to the underlying Node HTTP server
  ) {}

  /** The /health endpoint reads this. */
  get isShuttingDown() {
    return this.shuttingDown;
  }

  /** [1] Stop advertising that we are ready, and start the safety timer. */
  async onModuleDestroy() {
    this.shuttingDown = true;
    log(`[1] onModuleDestroy: /health now returns 503, waiting ${config.readinessDelayMs}ms`);

    // Safety net. If anything below hangs, exit with a clear log line instead of being
    // SIGKILLed silently. .unref() means the timer alone never keeps the process alive.
    setTimeout(() => {
      log(`HARD TIMEOUT after ${config.hardTimeoutMs}ms, forcing exit(1)`);
      process.exit(1);
    }, config.hardTimeoutMs).unref();

    // The load balancer needs a moment to notice the failing health check. Until then
    // it may still send requests, so the HTTP server stays open during this wait.
    await sleep(config.readinessDelayMs);
  }

  /** [2] Stop taking jobs and wait for the running ones (bounded by a deadline). */
  async beforeApplicationShutdown(signal?: string) {
    log(`[2] beforeApplicationShutdown (${signal}): draining jobs`);

    const { abandoned, notStarted } = await this.jobs.stopAndDrain(config.drainDeadlineMs);

    if (abandoned.length > 0) {
      // In a real queue these go back to waiting and another replica runs them.
      // That is why jobs must be idempotent.
      log(`abandoning unfinished jobs: ${abandoned.join(', ')}`);
    }
    if (notStarted.length > 0) log(`jobs never started: ${notStarted.join(', ')}`);
    if (abandoned.length === 0) log('all running jobs finished');

    // After this method returns, Nest closes the HTTP server and waits for
    // in-flight requests to finish.
    this.closeKeepAliveConnectionsAsTheyGoIdle();
  }

  /**
   * GOTCHA: browsers, load balancers and fetch() keep TCP connections open between
   * requests ("keep-alive"). server.close() waits for every connection to end, and an
   * idle keep-alive connection only ends after keepAliveTimeout (65s, longer than the
   * ECS stopTimeout!). Node only closes the connections that are idle at the moment
   * close() is called, so a connection that finishes its request a bit later would
   * keep us alive until SIGKILL.
   *
   * Fix: while shutting down, repeatedly close connections that have become idle.
   * Connections with a request in progress are NOT touched, so nothing gets cut.
   */
  private closeKeepAliveConnectionsAsTheyGoIdle() {
    const server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    setInterval(() => server.closeIdleConnections(), 100).unref();
  }

  /** [3] Close connections last. (Nothing to close here, but this is where it goes.) */
  async onApplicationShutdown(signal?: string) {
    log(`[3] onApplicationShutdown (${signal}): closing connections (DB, Redis, ...)`);
    // await this.dataSource.destroy();
    // await this.redis.quit();
    log('[4] shutdown complete');
  }
}
