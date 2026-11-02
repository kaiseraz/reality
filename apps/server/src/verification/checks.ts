import { z } from 'zod';
import { LAB_CHECKS } from '../lab/checks.ts';
import { CAD_CHECK } from '../lab/cad-check.ts';
import { DESIGN_CHECK } from '../lab/design.ts';
import { PCB_CHECK_DEF } from '../lab/pcb.ts';
import { ROCKET_CHECKS } from '../lab/rocket-checks.ts';

/**
 * Verification checks: independent re-computations that confirm a result from the raw
 * data. They deliberately avoid pandas and the recipe code paths (plain csv + math), so
 * a bug in a recipe cannot "verify itself". Each writes /output/summary.json with
 * { passed, checked, max_abs_error, mismatches } and prints a one-line verdict.
 */
export interface Check {
  name: string;
  description: string;
  params: z.ZodType<Record<string, unknown>>;
  /** Whether the check needs the output of a plan step mounted as /input/result.csv. */
  needsResult: boolean;
  /** False for checks that only read the step result (e.g. research without a dataset). */
  needsData?: boolean;
  /** Mounts the step's stored files (e.g. CAD meshes) under /input. */
  needsFiles?: boolean;
  body: string;
}

export function checkPrelude(params: unknown, claim: unknown = null): string {
  const literal = JSON.stringify(JSON.stringify(params));
  return [
    'import csv, json, math',
    `P = json.loads(${literal})`,
    // The step's own summary: data to be verified, never trusted.
    `CLAIM = json.loads(${JSON.stringify(JSON.stringify(claim ?? null))})`,
    'def rows(path):',
    '    with open(path, newline="") as f:',
    '        return list(csv.DictReader(f))',
    'def num(v):',
    '    return float(v) if v not in (None, "") else 0.0',
    'def close(a, b):',
    '    return abs(a - b) <= 1e-6 * max(1.0, abs(a), abs(b))',
    'def verdict(passed, checked, max_err, mismatches, note):',
    '    with open("/output/summary.json", "w") as f:',
    '        json.dump({"passed": passed, "checked": checked, "max_abs_error": max_err,',
    '                   "mismatches": mismatches[:5], "note": note}, f)',
    '    print(("PASS: " if passed else "FAIL: ") + note)',
    '',
  ].join('\n');
}

const col = z.string().min(1).max(200);

export const CHECKS: readonly Check[] = [
  {
    name: 'sql_result_matches',
    description:
      'Re-runs the same SQL with an independent engine (SQLite from the Python standard library) on the raw CSV loaded as table "data", and compares the rows with the reported result.',
    params: z.object({ step: z.string(), sql: z.string().min(1).max(20_000) }).strict(),
    needsResult: true,
    body: `
import re, sqlite3
src = rows("/input/data.csv")
cols = list(src[0].keys()) if src else []
def conv(v):
    if v in (None, ""): return None
    try:
        f = float(v)
        return int(f) if f.is_integer() and re.fullmatch(r"-?\\d+", v.strip()) else f
    except ValueError:
        return v
db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE data (" + ", ".join('"' + c.replace('"', '""') + '"' for c in cols) + ")")
db.executemany("INSERT INTO data VALUES (" + ", ".join("?" for _ in cols) + ")",
               [[conv(r[c]) for c in cols] for r in src])
try:
    expected = [list(r) for r in db.execute(P["sql"]).fetchall()]
except sqlite3.Error as e:
    with open("/output/summary.json", "w") as f:
        json.dump({"passed": False, "unsupported": True, "checked": 0, "max_abs_error": 0, "mismatches": [],
                   "note": f"Not checked: the independent engine (SQLite) cannot run this query ({e})."}, f)
    print("UNSUPPORTED:", e)
    raise SystemExit(0)
reported = [[conv(v) for v in r.values()] for r in rows("/input/result.csv")]
def same(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)): return close(float(a), float(b))
    return (None if a in (None, "") else str(a)) == (None if b in (None, "") else str(b))
def key(r): return [("" if v is None else str(round(v, 6)) if isinstance(v, float) else str(v)) for v in r]
ordered = re.search(r"\\border\\s+by\\b", P["sql"], re.I) is not None
a, b = (expected, reported) if ordered else (sorted(expected, key=key), sorted(reported, key=key))
mismatches = []
if len(a) != len(b):
    mismatches.append({"problem": "row count", "expected": len(a), "reported": len(b)})
for i, (x, y) in enumerate(zip(a, b)):
    if len(x) != len(y) or not all(same(p, q) for p, q in zip(x, y)):
        mismatches.append({"row": i, "expected": x, "reported": y})
verdict(not mismatches, len(a), 0.0, mismatches,
        f"{len(a)} rows re-computed with SQLite{' in order' if ordered else ' (order-insensitive)'}; "
        + ("all match" if not mismatches else f"{len(mismatches)} mismatches"))
`,
  },
  {
    name: 'row_count',
    description: 'The input has exactly the expected number of data rows.',
    params: z.object({ expected: z.number().int().nonnegative() }).strict(),
    needsResult: false,
    body: `
n = len(rows("/input/data.csv"))
verdict(n == P["expected"], 1, abs(n - P["expected"]), [] if n == P["expected"] else [{"rows": n}],
        f"{n} rows read, expected {P['expected']}")
`,
  },
  {
    name: 'totals_match',
    description: 'Every per-date total equals an independent re-summation of the raw data.',
    params: z
      .object({ step: z.string(), date: col, value: col, resample: z.enum(['week']).optional() })
      .strict(),
    needsResult: true,
    body: `
import datetime
raw = {}
for r in rows("/input/data.csv"):
    key = r[P["date"]][:10]
    raw[key] = raw.get(key, 0.0) + num(r[P["value"]])
if P.get("resample") == "week":
    weeks, days = {}, {}
    for k, v in raw.items():
        d = datetime.date.fromisoformat(k)
        monday = (d - datetime.timedelta(days=d.weekday())).isoformat()
        weeks[monday] = weeks.get(monday, 0.0) + v
        days[monday] = days.get(monday, 0) + 1
    raw = {k: v for k, v in weeks.items() if days[k] == 7}
res = {r[P["date"]][:10]: num(r[P["value"]]) for r in rows("/input/result.csv")}
mismatches, max_err = [], 0.0
for k in sorted(set(raw) | set(res)):
    a, b = raw.get(k), res.get(k)
    if a is None or b is None or not close(a, b):
        mismatches.append({"date": k, "expected": a, "reported": b})
    else:
        max_err = max(max_err, abs(a - b))
grand_raw, grand_res = sum(raw.values()), sum(res.values())
ok = not mismatches and close(grand_raw, grand_res)
verdict(ok, len(raw), max_err, mismatches,
        f"{len(raw)} dates re-summed; total {grand_raw:.2f} vs reported {grand_res:.2f}")
`,
  },
  {
    name: 'breakdown_sums',
    description:
      'Group totals match an independent re-summation, add up to the total, shares sum to 1.',
    params: z.object({ step: z.string(), group: col, value: col }).strict(),
    needsResult: true,
    body: `
raw = {}
for r in rows("/input/data.csv"):
    raw[r[P["group"]]] = raw.get(r[P["group"]], 0.0) + num(r[P["value"]])
res_rows = rows("/input/result.csv")
res = {r[P["group"]]: num(r[P["value"]]) for r in res_rows}
share_sum = sum(num(r.get("share")) for r in res_rows)
mismatches, max_err = [], 0.0
for k in sorted(set(raw) | set(res)):
    a, b = raw.get(k), res.get(k)
    if a is None or b is None or not close(a, b):
        mismatches.append({"group": k, "expected": a, "reported": b})
    else:
        max_err = max(max_err, abs(a - b))
ok = not mismatches and abs(share_sum - 1.0) < 1e-9
verdict(ok, len(raw), max_err, mismatches,
        f"{len(raw)} groups re-summed; shares sum to {share_sum:.12f}")
`,
  },
  {
    name: 'decomposition_reconstructs',
    description:
      'Observed = trend + seasonal + residual for every date, and observed equals the raw per-date total.',
    params: z
      .object({ step: z.string(), date: col, value: col, resample: z.enum(['week']).optional() })
      .strict(),
    needsResult: true,
    body: `
import datetime
raw = {}
for r in rows("/input/data.csv"):
    key = r[P["date"]][:10]
    raw[key] = raw.get(key, 0.0) + num(r[P["value"]])
if P.get("resample") == "week":
    weeks, days = {}, {}
    for k, v in raw.items():
        d = datetime.date.fromisoformat(k)
        monday = (d - datetime.timedelta(days=d.weekday())).isoformat()
        weeks[monday] = weeks.get(monday, 0.0) + v
        days[monday] = days.get(monday, 0) + 1
    raw = {k: v for k, v in weeks.items() if days[k] == 7}
parts = {}
for r in rows("/input/result.csv"):
    parts.setdefault(r[P["date"]][:10], {})[r["component"]] = num(r[P["value"]])
mismatches, max_err = [], 0.0
for k in sorted(set(raw) | set(parts)):
    p = parts.get(k, {})
    if k not in raw or not all(c in p for c in ("observed", "trend", "seasonal", "residual")):
        mismatches.append({"date": k, "problem": "missing date or component"})
        continue
    recon = p["trend"] + p["seasonal"] + p["residual"]
    err = max(abs(recon - p["observed"]), abs(p["observed"] - raw[k]))
    if not (close(recon, p["observed"]) and close(p["observed"], raw[k])):
        mismatches.append({"date": k, "observed": p["observed"], "reconstructed": recon, "raw": raw[k]})
    max_err = max(max_err, err)
verdict(not mismatches, len(raw), max_err, mismatches,
        f"{len(parts)} dates: components reconstruct observed (max error {max_err:.2e})")
`,
  },
  {
    name: 'correlation_matches',
    description:
      'Every reported Pearson r and pair count equals an independent re-computation from the raw data, and the claimed strongest variable is the significant one with the largest |r|.',
    params: z
      .object({ step: z.string(), target: col, candidates: z.array(col).min(1).max(30) })
      .strict(),
    needsResult: true,
    body: `
def as_num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None
raw = rows("/input/data.csv")
res = {r["variable"]: r for r in rows("/input/result.csv")}
mismatches, max_err, checked = [], 0.0, 0
for c in P["candidates"]:
    if c == P["target"] or c not in res:
        continue
    pairs = [(as_num(r.get(c)), as_num(r.get(P["target"]))) for r in raw]
    pairs = [(x, y) for x, y in pairs if x is not None and y is not None]
    n = len(pairs)
    mx = sum(x for x, _ in pairs) / n
    my = sum(y for _, y in pairs) / n
    sxy = sum((x - mx) * (y - my) for x, y in pairs)
    sxx = sum((x - mx) ** 2 for x, _ in pairs)
    syy = sum((y - my) ** 2 for _, y in pairs)
    r = sxy / math.sqrt(sxx * syy)
    reported = num(res[c]["pearson_r"])
    checked += 1
    err = abs(r - reported)
    max_err = max(max_err, err)
    if int(num(res[c]["n"])) != n or not close(r, reported):
        mismatches.append({"variable": c, "expected_r": r, "reported_r": reported,
                           "expected_n": n, "reported_n": res[c]["n"]})
sig = [v for v in res.values() if v.get("significant") == "True"]
best = max(sig, key=lambda v: abs(num(v["pearson_r"])))["variable"] if sig else None
claimed = (CLAIM or {}).get("top_variable")
if claimed != best:
    mismatches.append({"problem": "strongest variable", "expected": best, "claimed": claimed})
verdict(not mismatches and checked > 0, checked, max_err, mismatches,
        f"{checked} correlations re-computed from raw data (max |r| error {max_err:.1e}); strongest significant: {best}")
`,
  },
  {
    name: 'forecast_backtest_matches',
    description:
      'The reported recent history equals the latest raw per-date totals, and the claimed backtest error and naive-forecast error are re-computed from the raw data and the reported backtest predictions.',
    params: z
      .object({
        step: z.string(),
        date: col,
        value: col,
        horizon: z.number().int().min(1).max(366),
        period: z.number().int().min(2).max(366).optional(),
        resample: z.enum(['week']).optional(),
      })
      .strict(),
    needsResult: true,
    body: `
import datetime
raw = {}
for r in rows("/input/data.csv"):
    key = r[P["date"]][:10]
    raw[key] = raw.get(key, 0.0) + num(r[P["value"]])
if P.get("resample") == "week":
    weeks, days = {}, {}
    for k, v in raw.items():
        d = datetime.date.fromisoformat(k)
        monday = (d - datetime.timedelta(days=d.weekday())).isoformat()
        weeks[monday] = weeks.get(monday, 0.0) + v
        days[monday] = days.get(monday, 0) + 1
    raw = {k: v for k, v in weeks.items() if days[k] == 7}
dates = sorted(raw)
series = [raw[k] for k in dates]
res = rows("/input/result.csv")
actual = {r[P["date"]][:10]: num(r[P["value"]]) for r in res if r["kind"] == "actual"}
backtest = {r[P["date"]][:10]: num(r[P["value"]]) for r in res if r["kind"] == "backtest"}
forecast = [r for r in res if r["kind"] == "forecast"]
H = P["horizon"]
mismatches = []
# The result shows recent history only; it must be exactly the latest raw dates.
if sorted(actual) != dates[-len(actual):] or not actual:
    mismatches.append({"problem": "history is not the most recent raw dates",
                       "reported_first": min(actual) if actual else None})
for k in actual:
    if k not in raw or not close(raw[k], actual[k]):
        mismatches.append({"date": k, "expected": raw.get(k), "reported": actual.get(k)})
last = dates[-H:]
if sorted(backtest) != last:
    mismatches.append({"problem": "backtest dates", "expected": last[:3], "reported": sorted(backtest)[:3]})
else:
    mae = sum(abs(backtest[k] - raw[k]) for k in last) / H
    if P.get("period"):
        naive = [series[len(series) - H + i - P["period"]] for i in range(H)]
    else:
        naive = [series[len(series) - H - 1]] * H
    naive_mae = sum(abs(n - raw[k]) for n, k in zip(naive, last)) / H
    claim = CLAIM or {}
    if not close(mae, num(claim.get("backtest_mae"))):
        mismatches.append({"problem": "backtest MAE", "expected": mae, "claimed": claim.get("backtest_mae")})
    if not close(naive_mae, num(claim.get("naive_mae"))):
        mismatches.append({"problem": "naive MAE", "expected": naive_mae, "claimed": claim.get("naive_mae")})
    if bool(claim.get("beats_naive")) != (mae < naive_mae):
        mismatches.append({"problem": "beats_naive", "expected": mae < naive_mae, "claimed": claim.get("beats_naive")})
if len(forecast) != H or (forecast and min(r[P["date"]][:10] for r in forecast) <= dates[-1]):
    mismatches.append({"problem": "forecast rows", "expected": H, "reported": len(forecast)})
verdict(not mismatches, len(actual), 0.0, mismatches,
        f"{len(actual)} recent actual values and the {H}-period backtest re-computed from raw data"
        + ("" if mismatches else f"; model MAE {mae:.3f} vs naive {naive_mae:.3f}"))
`,
  },
  {
    name: 'quotes_in_sources',
    description:
      'For a synthesize step: every claim must quote at least 8 consecutive words verbatim from the stored text of the source it cites (abstract or passage). Re-checked from the stored sources, never from the model.',
    params: z.object({ step: z.string() }).strict(),
    needsResult: true,
    needsData: false,
    body: `
import re
def norm(s):
    s = (s or "").lower()
    s = re.sub("[‘’‚‛]", "'", s)
    s = re.sub("[“”„‟]", '"', s)
    s = re.sub("[‐-―]", "-", s)
    return " ".join(re.sub(r"[\\W_]+", " ", s).split())
claims = rows("/input/result.csv")
mismatches = []
for c in claims:
    q = norm(c.get("quote"))
    if len(q.split()) < 8:
        mismatches.append({"claim": c.get("n"), "problem": "quote shorter than 8 words"})
    elif not c.get("evidence"):
        mismatches.append({"claim": c.get("n"), "problem": "cites unknown source " + str(c.get("ref"))})
    elif q not in norm(c.get("evidence")):
        mismatches.append({"claim": c.get("n"), "problem": "quote not found in " + str(c.get("ref"))})
passed = len(claims) > 0 and not mismatches
verdict(passed, len(claims), 0.0, mismatches,
        f"{len(claims) - len(mismatches)} of {len(claims)} claims quote their cited source verbatim"
        if claims else "No claims to check.")
`,
  },
  ...LAB_CHECKS,
  CAD_CHECK,
  ...ROCKET_CHECKS,
  DESIGN_CHECK,
  PCB_CHECK_DEF,
];

export function getCheck(name: string): Check | undefined {
  return CHECKS.find((c) => c.name === name);
}
