/** Tiny helpers shared by the whole app. */

/** console.log with a timestamp. The e2e tests read these lines to check the shutdown order. */
export const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

/** await sleep(500)  ->  waits 500 ms */
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
