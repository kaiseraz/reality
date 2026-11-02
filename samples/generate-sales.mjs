// Generates samples/sales_weekly.csv: SYNTHETIC data with a known ground truth, so
// analysis results can be checked. Revenue = base + trend + 52-week seasonality + noise.
// Deterministic (seeded PRNG): re-running produces the identical file.
import { writeFileSync } from 'node:fs';

let seed = 42;
const rand = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
const noise = () => (rand() + rand() + rand() - 1.5) * 20; // ~N(0, 10)

const regions = { North: { base: 1000, amp: 300 }, South: { base: 800, amp: 120 } };
const start = Date.UTC(2023, 0, 2); // a Monday
const lines = ['week,region,revenue,orders'];
for (let w = 0; w < 156; w++) {
  const week = new Date(start + w * 7 * 86400000).toISOString().slice(0, 10);
  for (const [region, { base, amp }] of Object.entries(regions)) {
    const revenue = base + 2 * w + amp * Math.sin((2 * Math.PI * w) / 52) + noise();
    const orders = Math.round(revenue / 25 + noise() / 5);
    lines.push(`${week},${region},${revenue.toFixed(2)},${orders}`);
  }
}
writeFileSync(new URL('./sales_weekly.csv', import.meta.url), lines.join('\n') + '\n');
console.log(`wrote ${lines.length - 1} rows`);
