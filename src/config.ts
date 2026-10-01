/**
 * All settings in one place, read from environment variables.
 * The e2e tests override them with small values so tests run fast.
 */
export const config = {
  port: Number(process.env.PORT ?? 3000),

  /**
   * After we start shutting down, /health returns 503. The load balancer needs a few
   * seconds to notice and stop sending traffic. We keep serving during this wait.
   */
  readinessDelayMs: Number(process.env.READINESS_DELAY_MS ?? 3000),

  /** Max time we wait for running background jobs. After that we give up on them. */
  drainDeadlineMs: Number(process.env.DRAIN_DEADLINE_MS ?? 20000),

  /**
   * Safety net: if shutdown is STILL not finished after this long, exit(1).
   * Without it, the orchestrator would SIGKILL us silently, with no log at all.
   *
   * Rule: drainDeadlineMs < hardTimeoutMs < ECS stopTimeout (default 30s)
   */
  hardTimeoutMs: Number(process.env.HARD_TIMEOUT_MS ?? 25000),
};
