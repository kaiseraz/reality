/**
 * Calibration of the seasonality permutation test (not part of npm test; ~1 minute):
 *   npx tsx eval/calibrate-seasonality.ts <path to statsmodels layer>
 * Reports the false-positive rate on pure noise and the detection rate (power) for
 * sinusoidal seasonality of increasing amplitude, with noise sd 40 over 156 weeks.
 * Also checks two cycles (104 weeks). Statistic: phase R² on the quadratically detrended series.
 * Result: 2/40 false positives (156 weeks); detected 1/10 at amplitude 20, 10/10 at 40,
 * 10/10 at 80; two cycles: 10/10 detected at amplitude 80, 5/40 false positives. A larger run
 * (400 noise series each) gave 21/400 = 5.25 % (156 weeks) and 27/400 = 6.75 % (104 weeks).
 */
import { STL_HELPERS } from '../src/analysis/recipes.ts';
import { DockerRunner } from '../src/sandbox/docker-runner.ts';

const layer = process.argv[2];
if (!layer)
  throw new Error('Usage: npx tsx eval/calibrate-seasonality.ts <statsmodels layer path>');
const code = `import sys, json\nsys.path[:0] = ["/caps/statsmodels"]\nimport pandas as pd\n${STL_HELPERS}
rng = np.random.default_rng(1)
idx = pd.date_range("2023-01-02", periods=156, freq="W-MON")
ps = []
for i in range(40):
    s = pd.Series(900 + np.arange(156) + rng.normal(0, 40, 156), index=idx)
    ps.append(permutation_p(s, 52, 999, seed=i))
power = {}
for amp in (20, 40, 80):
    hits = 0
    for i in range(10):
        s = pd.Series(900 + np.arange(156) + amp * np.sin(2 * np.pi * np.arange(156) / 52) + rng.normal(0, 40, 156), index=idx)
        hits += permutation_p(s, 52, 999, seed=100 + i) < 0.05
    power[amp] = hits
two = 0
for i in range(10):
    t2 = np.arange(104)
    s2 = pd.Series(900 + 2 * t2 + 80 * np.sin(2 * np.pi * t2 / 52) + rng.normal(0, 40, 104), index=pd.date_range("2023-01-02", periods=104, freq="W-MON"))
    two += permutation_p(s2, 52, 999, seed=200 + i) < 0.05
noise2 = 0
for i in range(40):
    s3 = pd.Series(900 + np.arange(104) + rng.normal(0, 40, 104), index=pd.date_range("2023-01-02", periods=104, freq="W-MON"))
    noise2 += permutation_p(s3, 52, 999, seed=300 + i) < 0.05
print(json.dumps({"two_cycles_detected_of_10_amp80": two, "two_cycles_noise_rejections_of_40": noise2}))
print(json.dumps({"noise_rejections": sum(p < 0.05 for p in ps), "noise_n": len(ps), "detected_of_10_by_amplitude_vs_noise_sd_40": power}))
`;
const r = await new DockerRunner('reality-sandbox-python:dev').run({
  code,
  readOnlyMounts: [{ hostPath: layer, containerPath: '/caps/statsmodels' }],
  limits: { timeoutMs: 600_000 },
});
console.log(
  r.status,
  (r.durationMs / 1000).toFixed(0) + 's',
  r.stdout.trim() || r.stderr.slice(-600),
);
await r.cleanup();
