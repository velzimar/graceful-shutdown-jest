/**
 * Test helper: captures console.log during a test and, only if SHOW_LOGS=1,
 * prints everything as ONE block after the test (so lines don't mix with Jest's output).
 *
 * Usage in a spec:
 *   let logs: LogCapture;
 *   beforeEach(() => { logs = captureLogs(); });
 *   afterEach(() => logs.finish());
 */
export interface LogCapture {
  /** Raw captured lines, in case a test wants to assert on them. */
  lines: string[];
  /** Stops capturing and prints the block if SHOW_LOGS=1. Call in afterEach. */
  finish(): void;
}

export function captureLogs(): LogCapture {
  const lines: string[] = [];
  const spy = jest
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });

  return {
    lines,
    finish() {
      spy.mockRestore();
      if (process.env.SHOW_LOGS !== "1") return;

      const name = expect.getState().currentTestName;
      const block = [
        `\n┌─ logs: ${name}`,
        ...(lines.length ? lines : ["(no logs)"]).map(
          // keep only the time (HH:MM:SS.mmm); the date is noise here
          (l) => `│ ${l.replace(/^\d{4}-\d\d-\d\dT/, "").replace("Z", "")}`,
        ),
        "└─\n",
      ];
      process.stderr.write(block.join("\n") + "\n");
    },
  };
}
