import { Injectable } from '@nestjs/common';
import { log, sleep } from './log';

/**
 * A tiny in-memory job queue. It stands in for BullMQ / SQS / RabbitMQ so the demo
 * needs no Redis. The shutdown ideas are identical with a real queue:
 *
 *   in-memory (this file)          BullMQ equivalent
 *   ───────────────────────────    ─────────────────────────────────────
 *   accepting = false              worker.pause()  /  worker.close()
 *   wait for `active` to empty     worker.close() waits for active jobs
 *   abandoned jobs are reported    jobs go back to the queue (lock expires)
 *   `processed` Set                a DB unique key / idempotency table
 */
export interface Job {
  id: string;
  durationMs: number; // how long the fake work takes
}

const CONCURRENCY = 2; // how many jobs may run at the same time

@Injectable()
export class JobsService {
  private waiting: Job[] = []; // queued, not started
  private active = new Set<Job>(); // running right now
  private accepting = true; // false once shutdown starts: no new jobs are started
  private aborted = false; // true if we gave up waiting: running jobs stop working

  /** Ids whose effect was already applied (this is the "idempotency store"). */
  private processed = new Set<string>();
  /** What the jobs "did" to the outside world (think: rows written, emails sent). */
  private effects: string[] = [];

  private counter = 0;

  /** Add a job to the queue. Passing an id lets tests simulate "same job delivered twice". */
  enqueue(durationMs: number, id = `job-${++this.counter}`): string {
    this.waiting.push({ id, durationMs });
    this.pump();
    return id;
  }

  /** Start waiting jobs while there is room. Does nothing after shutdown started. */
  private pump() {
    while (this.accepting && this.active.size < CONCURRENCY && this.waiting.length > 0) {
      void this.run(this.waiting.shift()!);
    }
  }

  private async run(job: Job) {
    this.active.add(job);
    log(`job ${job.id} started`);
    try {
      const finished = await this.doWork(job.durationMs);
      if (!finished) {
        log(`job ${job.id} aborted before finishing, no effect applied`);
        return;
      }
      this.applyEffect(job.id);
      log(`job ${job.id} finished`);
    } finally {
      this.active.delete(job);
      this.pump(); // a slot is free: start the next waiting job
    }
  }

  /**
   * Fake work. Sleeps in small steps so it can notice `aborted` quickly.
   * (A real worker would stop renewing its lock here, so the queue hands the job
   * to another replica.)
   */
  private async doWork(ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.aborted) return false;
      await sleep(Math.max(0, Math.min(50, end - Date.now())));
    }
    return !this.aborted;
  }

  /**
   * IDEMPOTENCY: running the same job twice must have the same result as once.
   * Queues deliver "at least once": if a container is killed mid-job, the job is
   * redelivered. This check is what prevents the "processed twice" symptom.
   * (In a real app: a unique key, or a "processed" row, in the SAME DB transaction
   * as the side effect.)
   */
  private applyEffect(id: string) {
    if (this.processed.has(id)) {
      log(`job ${id} was already processed, skipping (idempotent)`);
      return;
    }
    this.processed.add(id);
    this.effects.push(id);
  }

  /**
   * Called during shutdown.
   *   1. stop starting new jobs
   *   2. wait for running jobs to finish, but never longer than deadlineMs
   *   3. if some are still running, abort them and report which ones
   */
  async stopAndDrain(deadlineMs: number): Promise<{ abandoned: string[]; notStarted: string[] }> {
    this.accepting = false;

    const start = Date.now();
    while (this.active.size > 0 && Date.now() - start < deadlineMs) {
      await sleep(50);
    }

    const abandoned = [...this.active].map((j) => j.id);
    if (abandoned.length > 0) this.aborted = true;

    return { abandoned, notStarted: this.waiting.map((j) => j.id) };
  }

  stats() {
    return { waiting: this.waiting.length, active: this.active.size, effects: [...this.effects] };
  }
}
