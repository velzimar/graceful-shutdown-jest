import { ChildProcess, spawn } from "child_process";
import * as path from "path";

/**
 * Test helper: starts the compiled app (node dist/main.js) as a REAL child process,
 * so we can send it a REAL SIGTERM, exactly like ECS / Docker does.
 *
 * (Calling app.close() inside Jest would NOT test this: it skips the signal handling.)
 */
export interface RunningApp {
  url: string;
  /** Everything the app printed so far. */
  logs(): string;
  /** Resolves when the app prints `text`. */
  waitForLog(text: string, timeoutMs?: number): Promise<void>;
  /** Send SIGTERM, like the orchestrator does. */
  sigterm(): void;
  /** Resolves when the process ends. signal='SIGTERM' means a clean shutdown (see README). */
  exited: Promise<{ code: number | null; signal: string | null }>;
}
const apps: { getOutput: () => string }[] = [];
const started: ChildProcess[] = [];
let nextPort = 3100 + Math.floor(Math.random() * 500); // each test gets its own port

export async function startApp(
  env: Record<string, string> = {},
): Promise<RunningApp> {
  const port = nextPort++;

  const child = spawn("node", ["dist/main.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      // Small timings so tests are fast. Production defaults are in src/config.ts.
      READINESS_DELAY_MS: "500",
      DRAIN_DEADLINE_MS: "2000",
      HARD_TIMEOUT_MS: "4000",
      ...env,
    },
  });
  started.push(child);

  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  apps.push({ getOutput: () => output });
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => child.on("exit", (code, signal) => resolve({ code, signal })),
  );

  const waitForLog = async (text: string, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!output.includes(text)) {
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for "${text}". Logs:\n${output}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  await waitForLog("listening on port");

  return {
    url: `http://127.0.0.1:${port}`,
    logs: () => output,
    waitForLog,
    sigterm: () => child.kill("SIGTERM"),
    exited,
  };
}

/** Call in afterEach: never leave a process running if a test fails halfway. */
export function killAllApps() {
  if (process.env.SHOW_APP_LOGS === "1") printAppLogs();
  apps.length = 0;
  for (const child of started.splice(0)) child.kill("SIGKILL");
}

/** Prints everything the app(s) logged during the current test, as ONE block. */
function printAppLogs() {
  const testName = expect.getState().currentTestName;
  const lines = [`\n┌─ app logs: ${testName}`];

  for (const app of apps) {
    for (const line of app.getOutput().split("\n").filter(Boolean)) {
      // keep only the time (HH:MM:SS.mmm), the date is just noise here
      lines.push(`│ ${line.replace(/^\d{4}-\d\d-\d\dT/, "").replace("Z", "")}`);
    }
  }

  lines.push("└─\n");
  process.stderr.write(lines.join("\n") + "\n");
}
