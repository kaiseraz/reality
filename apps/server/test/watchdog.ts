/**
 * A test run that stops moving says so and ends, instead of sitting there until someone looks: the
 * whole suite takes about 11 minutes, so 40 without an end means something is stuck.
 */
export default function watchdog(): () => void {
  const limit = Number(process.env.TEST_DEADLINE_MS ?? 40 * 60_000);
  const timer = setTimeout(() => {
    console.error(
      `The test run was still going after ${Math.round(limit / 60_000)} minutes: stopping it.`,
    );
    process.exit(124);
  }, limit);
  timer.unref();
  return () => clearTimeout(timer);
}
