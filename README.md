# Graceful shutdown in NestJS, tested with Jest

A small NestJS app that shuts down properly when it receives `SIGTERM`
(what ECS / Docker / Kubernetes send during a rolling deployment), plus Jest tests that
prove it. No Docker, Redis or shell scripts needed.

## Quick start (WSL / Linux / macOS)

```bash
# Node 24.14.1 via nvm (skip if already installed)
nvm install 24.14.1 && nvm use 24.14.1

npm install
npm run test:unit    # unit tests of the job queue, with logs  (~10 s)
npm test             # e2e tests: real process + real SIGTERM, with app logs (~20 s)
```

> Run in **WSL2 (Ubuntu)**, not in Git Bash/PowerShell. Native Windows Node cannot receive
> `SIGTERM`, so the e2e tests are skipped there. Work from your Linux home (`~/...`), not
> from `/mnt/c/...`, and open VS Code from that folder with `code .` so the status bar
> shows **WSL: Ubuntu**.

## Project layout

```
src/
  main.ts                 starts the app, enables shutdown hooks
  config.ts               timeouts, read from environment variables
  shutdown.service.ts     THE shutdown order (read this first)
  jobs.service.ts         in-memory job queue: drain, deadline, idempotency
  app.controller.ts       /health /slow /jobs /stats (endpoints used by the tests)
  jobs.service.spec.ts    unit tests of the job queue
test/
  shutdown.spec.ts        e2e tests (real child process + real SIGTERM)
  app-process.ts          helper: starts `node dist/main.js`, captures its output
  log-capture.ts          helper: captures console.log in unit tests
  global-setup.js         compiles the app once before the tests
```

## Scripts

| Command                | What it runs                                              |
| ---------------------- | --------------------------------------------------------- |
| `npm run build`        | compiles `src/` to `dist/`                                |
| `npm start`            | runs the compiled app (`node dist/main.js`)               |
| `npm test`             | **e2e only**: `SHOW_APP_LOGS=1 npx jest test --runInBand` |
| `npm run test:unit`    | **unit only**: `SHOW_LOGS=1 npx jest src --runInBand`     |
| `npm run test:e2e`     | e2e tests without logs (quiet, if you kept this script)   |
| `npx jest --runInBand` | **everything** (unit + e2e), quiet                        |

Notes:

- `npm test` does not run the unit tests. Run `npm run test:unit` as well, or `npx jest --runInBand` for both.
- `VAR=1 command` is bash syntax. In PowerShell/cmd use `cross-env`
  (`npm i -D cross-env`, then `cross-env SHOW_LOGS=1 jest src`).
- `--runInBand` runs test files one after another so log blocks never interleave.
- To silence the logs, call jest directly: `npx jest src` or `npx jest test`.
- Run one test by name: `npx jest -t "hard timeout"`.

## Seeing the logs

Both log switches print **one block per test**, after the test, with the test name as a header.

| Variable          | Used by    | What it shows                                  |
| ----------------- | ---------- | ---------------------------------------------- |
| `SHOW_LOGS=1`     | unit tests | what `JobsService` logged during the test      |
| `SHOW_APP_LOGS=1` | e2e tests  | everything the child process (the app) printed |

Example (unit, idempotency test):

```
┌─ logs: JobsService is idempotent: the same job delivered twice has its effect applied once
│ 21:17:54.701 job same-id started
│ 21:17:54.732 job same-id finished
│ 21:17:54.821 job same-id started
│ 21:17:54.852 job same-id was already processed, skipping (idempotent)
│ 21:17:54.852 job same-id finished
└─
```

The logs are also available inside tests: `logs.lines` (unit) or `app.logs()` (e2e), so a test
can assert on a log line, for example `expect(logs.lines.join('\n')).toContain('skipping (idempotent)')`.

## The problem

During a deployment the orchestrator does this:

```
SIGTERM ───────── stopTimeout (30 s by default) ─────────► SIGKILL
        "please stop"                                      cannot be caught
```

If the app just dies on SIGTERM you get failed in-flight requests, and jobs interrupted
halfway then redelivered ("processed twice").

## The solution, step by step

`src/shutdown.service.ts` owns the order. It is heavily commented.

| Step | Hook                                     | What happens                                                       | Why                                                                        |
| ---- | ---------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 0    | `app.enableShutdownHooks()` in `main.ts` | SIGTERM triggers the hooks                                         | Without it Nest ignores the signal                                         |
| 1    | `onModuleDestroy`                        | `/health` returns 503, wait a moment, start the hard-timeout timer | The load balancer must stop sending traffic _before_ we close the listener |
| 2    | `beforeApplicationShutdown`              | Stop starting jobs, wait for running ones (up to a deadline)       | Finish work cleanly, never wait forever                                    |
| 3    | _(Nest)_                                 | Close the HTTP server, wait for in-flight requests                 | Don't cut requests                                                         |
| 4    | `onApplicationShutdown`                  | Close DB / Redis / queues                                          | Dependencies close **last**, steps 2-3 still need them                     |

### Keep-alive gotcha

Browsers, load balancers and `fetch()` keep TCP connections open between requests.
`server.close()` waits for every connection, and an idle one only ends after
`keepAliveTimeout` (65 s, longer than the ECS `stopTimeout`). `ShutdownService` closes
connections as they become idle (`closeIdleConnections()` every 100 ms), without touching
requests in progress. The e2e test "lets an in-flight HTTP request finish" caught this bug.

### What if work cannot finish in time?

1. **Deadline**: `DRAIN_DEADLINE_MS` limits the wait. Then the jobs are abandoned and logged.
2. **Hand it back**: a real queue (BullMQ, SQS) re-delivers abandoned jobs to another replica.
   In memory they are simply lost, so this demo only _reports_ them.
3. **Idempotency**: redelivery means a job can run twice, so running it twice must be harmless
   (`applyEffect` in `jobs.service.ts`; in real life a unique key in the same DB transaction).
4. **Hard timeout**: if shutdown hangs, `HARD_TIMEOUT_MS` exits with code 1 and a log line,
   instead of a silent SIGKILL.

Keep: `DRAIN_DEADLINE_MS` < `HARD_TIMEOUT_MS` < ECS `stopTimeout`.

## The tests

### Unit: `src/jobs.service.spec.ts` (12 tests, no process, no signals)

| Group       | What is checked                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| basics      | a job applies its effect once; ids are unique when not given                                                                                                                                                                                           |
| concurrency | at most 2 jobs run at once; a waiting job starts when a slot frees up                                                                                                                                                                                  |
| idempotency | the same job delivered twice, one after the other **or at the same time**, applies its effect once                                                                                                                                                     |
| drain       | returns immediately when idle; waits for a job that fits the deadline; gives up at the deadline and reports the abandoned job (no effect applied); abandons only the slow job; starts no new jobs once draining began; reports jobs that never started |

Test hygiene: `afterEach` waits until no job is running (`active === 0`). Without it, a job
left over from one test logs into the **next** test's capture (`console.log` is global).

### E2E: `test/shutdown.spec.ts` (6 tests, real child process + real `SIGTERM`)

- hooks run in order `[1]` → `[2]` → `[3]` → `[4]`
- an in-flight HTTP request completes with 200
- `/health` flips to 503 as soon as shutdown starts
- a running job that fits the deadline is allowed to finish
- a job that cannot finish is abandoned, and the process still exits cleanly
- if shutdown hangs, the hard timeout exits with code 1

### Why a real process instead of `app.close()`?

`app.close()` inside Jest skips the signal handling, so it cannot catch the classic bugs
(hooks never registered, signal never reaching Node, hanging connections).

### Reading the exit status

After a clean shutdown Nest re-sends the signal to itself, so a clean stop is
`signal === 'SIGTERM'` (Docker shows exit code **143**), not 0.
Code **1** means our hard timeout fired. **137** means SIGKILL.
|

## Mapping to a real app

- In-memory queue → BullMQ: `worker.close()` stops fetching and waits for active jobs.
- `onApplicationShutdown` → `await dataSource.destroy(); await redis.quit();`
- Container: run `node dist/main.js` directly (see `Dockerfile`), never `npm start`
  (npm does not forward SIGTERM to node).
- ECS: set `stopTimeout` above `HARD_TIMEOUT_MS`, and lower the ALB deregistration delay
  from its 300 s default to roughly your readiness delay plus the longest request.
