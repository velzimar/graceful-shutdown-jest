import { captureLogs, LogCapture } from "../test/log-capture";
import { JobsService } from "./jobs.service";
import { sleep } from "./log";

/*
 * Unit tests for the job queue. No HTTP, no process, no signals.
 * They cover the "work that cannot finish" rules:
 *   - the drain waits for running jobs, but only up to a deadline
 *   - jobs are idempotent, so a redelivered job does not double its effect
 * plus the queue basics (concurrency, ids, jobs that never started).
 *
 * Job logs are hidden by default. To see them, one block per test:
 *   SHOW_LOGS=1 npx jest src --runInBand
 */

/** Polls until `condition` is true. More robust than a fixed sleep(). */
async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await sleep(10);
  }
}

describe("JobsService", () => {
  let jobs: JobsService;
  let logs: LogCapture;

  beforeEach(() => {
    jobs = new JobsService();
    // Captures console.log: hidden normally, printed as one block if SHOW_LOGS=1.
    // (Do NOT also mock console.log here, it would replace the capture.)
    logs = captureLogs();
  });
  afterEach(async () => {
    // No job may outlive its test: a leftover job would log into the NEXT test's capture
    // (console.log is global) and could even change its results.
    await waitFor(() => jobs.stats().active === 0);
    logs.finish();
  });

  // ───────────── basics ─────────────

  it("runs a job and applies its effect once", async () => {
    jobs.enqueue(50, "a");
    await sleep(150);
    expect(jobs.stats().effects).toEqual(["a"]);
  });

  it("generates a unique id when none is given", () => {
    const a = jobs.enqueue(10);
    const b = jobs.enqueue(10);
    expect(a).not.toBe(b);
  });

  // ───────────── concurrency ─────────────

  it("runs at most 2 jobs at the same time and queues the rest", async () => {
    jobs.enqueue(100);
    jobs.enqueue(100);
    jobs.enqueue(100);
    expect(jobs.stats()).toMatchObject({ active: 2, waiting: 1 });

    // Let everything finish so no job logs after the test ended
    await waitFor(() => jobs.stats().effects.length === 3);
  });

  it("starts the waiting job as soon as a slot frees up", async () => {
    jobs.enqueue(50);
    jobs.enqueue(50);
    jobs.enqueue(50);
    await waitFor(() => jobs.stats().effects.length === 3);
    expect(jobs.stats()).toMatchObject({ active: 0, waiting: 0 });
  });

  // ───────────── idempotency ─────────────

  it("is idempotent: the same job delivered twice has its effect applied once", async () => {
    jobs.enqueue(30, "same-id");
    await sleep(120); // first delivery done
    jobs.enqueue(30, "same-id"); // queue redelivers it (e.g. after a crash)
    await sleep(120);
    expect(jobs.stats().effects).toEqual(["same-id"]); // NOT ['same-id', 'same-id']
    expect(logs.lines.join("\n")).toContain("skipping (idempotent)");
  });

  it("is idempotent even when the same job runs twice AT THE SAME TIME", async () => {
    jobs.enqueue(50, "dup");
    jobs.enqueue(50, "dup");
    await waitFor(() => jobs.stats().active === 0);
    expect(jobs.stats().effects).toEqual(["dup"]);
  });

  // ───────────── drain ─────────────

  it("drain returns immediately when nothing is running", async () => {
    const start = Date.now();
    const result = await jobs.stopAndDrain(5000);
    expect(result).toEqual({ abandoned: [], notStarted: [] });
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("drain waits for a running job that fits inside the deadline", async () => {
    jobs.enqueue(200, "quick");
    const result = await jobs.stopAndDrain(2000);
    expect(result.abandoned).toEqual([]);
    expect(jobs.stats().effects).toEqual(["quick"]);
  });

  it("drain gives up at the deadline and reports the abandoned job", async () => {
    jobs.enqueue(5000, "too-long");
    const result = await jobs.stopAndDrain(100);
    expect(result.abandoned).toEqual(["too-long"]);

    await sleep(150); // the aborted job must stop and NOT apply its effect
    expect(jobs.stats().effects).toEqual([]);
    expect(logs.lines.join("\n")).toContain("aborted before finishing");
  });

  it("only abandons the jobs that are too slow, finished ones keep their effect", async () => {
    jobs.enqueue(50, "fast");
    jobs.enqueue(5000, "slow");

    const result = await jobs.stopAndDrain(300);

    expect(result.abandoned).toEqual(["slow"]);
    expect(jobs.stats().effects).toEqual(["fast"]);

    // The aborted job notices within ~50ms and stops; wait for it
    await waitFor(() => jobs.stats().active === 0);
  });

  it("does not start new jobs once draining began", async () => {
    await jobs.stopAndDrain(100);
    jobs.enqueue(50, "late");
    await sleep(150);
    expect(jobs.stats()).toMatchObject({ waiting: 1, active: 0, effects: [] });
  });

  it("drain reports jobs that never started (still waiting in the queue)", async () => {
    jobs.enqueue(100); // job-1 runs
    jobs.enqueue(100); // job-2 runs
    jobs.enqueue(100); // job-3 waits: concurrency is 2

    const result = await jobs.stopAndDrain(2000);

    expect(result.abandoned).toEqual([]); // the 2 running jobs finished
    expect(result.notStarted).toEqual(["job-3"]); // the 3rd was never started
    expect(jobs.stats().effects.sort()).toEqual(["job-1", "job-2"]);
  });
});
