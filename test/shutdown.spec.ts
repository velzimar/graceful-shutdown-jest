import { killAllApps, startApp } from "./app-process";
/**
 * End-to-end tests: start the real app, send it SIGTERM, check what happens.
 *
 * Needs a real SIGTERM, so run on Linux, macOS or WSL2.
 * (Native Windows Node cannot receive SIGTERM, so these tests are skipped there.)
 *
 * About exit values: after a clean shutdown Nest re-sends the signal to itself, so a
 * clean stop shows up as signal === 'SIGTERM' (Docker shows exit code 143).
 * A forced exit via our safety timer is code 1.
 */
const describeOnUnix = process.platform === "win32" ? describe.skip : describe;

describeOnUnix("graceful shutdown (real process + real SIGTERM)", () => {
  afterEach(killAllApps);

  it("runs the hooks in the right order", async () => {
    const app = await startApp();

    app.sigterm();
    await app.exited;

    const logs = app.logs();
    const order = [
      "[1] onModuleDestroy",
      "[2] beforeApplicationShutdown",
      "[3] onApplicationShutdown",
      "[4] shutdown complete",
    ];
    const positions = order.map((line) => logs.indexOf(line));

    expect(positions.every((p) => p >= 0)).toBe(true); // every step ran
    expect([...positions].sort((a, b) => a - b)).toEqual(positions); // in this order
  });

  it("lets an in-flight HTTP request finish instead of cutting it", async () => {
    const app = await startApp();

    const response = fetch(`${app.url}/slow?ms=1500`); // takes 1.5s
    await app.waitForLog("/slow started");

    app.sigterm(); // shutdown begins while the request is still running

    const res = await response;
    expect(res.status).toBe(200); // the request was NOT dropped

    const { signal } = await app.exited;
    expect(signal).toBe("SIGTERM"); // clean shutdown, not a crash
  });

  it("makes /health return 503 as soon as shutdown starts", async () => {
    const app = await startApp();
    expect((await fetch(`${app.url}/health`)).status).toBe(200); // healthy before

    app.sigterm();
    await app.waitForLog("[1] onModuleDestroy");

    // Still inside the readiness delay: server is open, but tells the LB to go away.
    expect((await fetch(`${app.url}/health`)).status).toBe(503);
  });

  it("waits for a running background job that fits inside the deadline", async () => {
    const app = await startApp();

    await fetch(`${app.url}/jobs?ms=1000&id=quick-job`, { method: "POST" });
    await app.waitForLog("job quick-job started");

    app.sigterm();
    const { signal } = await app.exited;

    expect(app.logs()).toContain("job quick-job finished"); // it was allowed to finish
    expect(app.logs()).toContain("all running jobs finished");
    expect(signal).toBe("SIGTERM");
  });

  it("abandons a job that cannot finish in time, and still exits cleanly", async () => {
    const app = await startApp(); // drain deadline = 2s

    await fetch(`${app.url}/jobs?ms=60000&id=huge-job`, { method: "POST" }); // way too long
    await app.waitForLog("job huge-job started");

    app.sigterm();
    const { signal } = await app.exited;

    expect(app.logs()).toContain("abandoning unfinished jobs: huge-job");
    expect(app.logs()).not.toContain("job huge-job finished"); // effect was NOT applied
    expect(app.logs()).not.toContain("HARD TIMEOUT"); // we exited by ourselves, in time
    expect(signal).toBe("SIGTERM");
  });

  it("hard timeout: exits with code 1 if shutdown hangs, instead of being SIGKILLed", async () => {
    const app = await startApp(); // hard timeout = 4s

    // A 60s request keeps the HTTP server from closing, so shutdown hangs.
    fetch(`${app.url}/slow?ms=60000`).catch(() => {}); // connection will be cut: ignore
    await app.waitForLog("/slow started");

    app.sigterm();
    const { code } = await app.exited;

    expect(app.logs()).toContain("HARD TIMEOUT");
    expect(code).toBe(1);
  });
});
