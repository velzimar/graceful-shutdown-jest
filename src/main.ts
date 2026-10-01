import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { log } from './log';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });

  // THE most important line. Without it, Nest ignores SIGTERM and the process is
  // killed instantly. With it, SIGTERM runs the lifecycle hooks in ShutdownService.
  app.enableShutdownHooks();

  // Behind an AWS load balancer (idle timeout 60s), Node's keep-alive timeout must be
  // LONGER, otherwise the LB may reuse a connection that Node just closed -> random 502s.
  const server = app.getHttpServer();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await app.listen(config.port, '0.0.0.0');
  log(`listening on port ${config.port}`); // the e2e tests wait for this line
}

bootstrap();
