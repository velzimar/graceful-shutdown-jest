import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { JobsService } from './jobs.service';
import { ShutdownService } from './shutdown.service';

@Module({
  controllers: [AppController],
  providers: [JobsService, ShutdownService],
})
export class AppModule {}
