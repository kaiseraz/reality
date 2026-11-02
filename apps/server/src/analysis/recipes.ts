import { z } from 'zod';

/**
 * Built-in analysis recipes: reviewed Python templates executed in the sandbox.
 * They make Reality usable without an AI analyst and give the AI analyst a tested
 * baseline. Parameters (including column names from untrusted data) reach Python only
 * via json.loads of a JSON literal — never by string interpolation into code.
 */
export interface Recipe {
  name: string;
  description: string;
  params: z.ZodType<Record<string, unknown>>;
  /** Capability ids that must be enabled (mounted) for the code to run. */
  requires: readonly string[];
  body: string;
}

/** Shared prelude: params, input data, safe output helpers. */
export function prelude(params: unknown, capabilityPaths: readonly string[] = []): string {
  // A JSON string literal is also a valid Python string literal.
  const literal = JSON.stringify(JSON.stringify(params));
  return [
    'import json, re, sys',
    `sys.path[:0] = json.loads(${JSON.stringify(JSON.stringify(capabilityPaths))})`,
    'import numpy as np, pandas as pd',
    `P = json.loads(${literal})`,
    'df = pd.read_csv("/input/data.csv")',
    'def safe(name):',
    '    s = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(name)).strip("._-") or "x"',
    '    return s[:60]',
    'def out_csv(frame, name):',
    '    frame.to_csv("/output/" + safe(name), index=False)',
    'def summary(d):',
    '    with open("/output/summary.json", "w") as f: json.dump(d, f, default=str)',
    'def weekly(s):',
    '    # Calendar weeks starting Monday; only complete weeks (7 daily values) are kept.',
    '    start = s.index - pd.to_timedelta(s.index.weekday, unit="D")',
    '    g = s.groupby(start)',
    '    return g.sum()[g.count() == 7]',
    'def series_by_date(date, value, frame=None, resample=None):',
    '    d = (df if frame is None else frame)[[date, value]].copy()',
    '    d[date] = pd.to_datetime(d[date])',
    '    s = d.groupby(date)[value].sum().sort_index()',
    '    return weekly(s) if resample == "week" else s',
    '',
  ].join('\n');
}

const col = z.string().min(1).max(200);

/**
 * STL plus a permutation test for seasonality. H0: no seasonal pattern. The detrended
 * values are shuffled in time (destroying any seasonal structure but keeping their
 * distribution), the trend is added back and STL is refitted; the p-value is the share
 * of shuffles whose seasonal strength reaches the observed one. Seeded: reproducible.
 */
export const STL_HELPERS = `
import numpy as np
from statsmodels.tsa.seasonal import STL
ALPHA = 0.05
def stl_fit(s, period):
    res = STL(s, period=period, robust=True).fit()
    var_sr = float((res.seasonal + res.resid).var())
    strength = max(0.0, 1.0 - float(res.resid.var()) / var_sr) if var_sr > 0 else 0.0
    return res, strength
def phase_r2(values, period):
    # Share of variance explained by the position in the cycle (one mean per phase).
    # Unlike STL's seasonal strength it does not saturate when only 2-3 cycles exist.
    v = np.asarray(values, dtype=float)
    phase = np.arange(len(v)) % period
    total = float(((v - v.mean()) ** 2).sum())
    if total == 0:
        return 0.0
    means = np.bincount(phase, weights=v, minlength=period) / np.bincount(phase, minlength=period)
    return 1.0 - float(((v - means[phase]) ** 2).sum()) / total
def permutation_p(s, period, n, seed=20261020):
    # H0: no seasonality. Remove a quadratic trend, then compare the observed phase R²
    # with the R² of the same values shuffled in time (which destroys any cycle).
    t = np.arange(len(s), dtype=float)
    detrended = s.values - np.polyval(np.polyfit(t, s.values, 2), t)
    observed = phase_r2(detrended, period)
    rng = np.random.default_rng(seed)
    exceed = sum(phase_r2(rng.permutation(detrended), period) >= observed for _ in range(n))
    return (exceed + 1) / (n + 1)
`;

export const RECIPES: readonly Recipe[] = [
  {
    name: 'profile',
    description: 'Profile every column: type, nulls, distinct values, numeric range.',
    params: z.object({}).strict(),
    requires: [],
    body: `
rows = []
for c in df.columns:
    s = df[c]
    num = pd.api.types.is_numeric_dtype(s)
    rows.append({
        "column": c, "dtype": str(s.dtype), "non_null": int(s.notna().sum()),
        "nulls": int(s.isna().sum()), "distinct": int(s.nunique()),
        "mean": float(s.mean()) if num else None,
        "min": float(s.min()) if num else None, "max": float(s.max()) if num else None,
    })
out_csv(pd.DataFrame(rows), "profile.csv")
summary({"rows": len(df), "columns": len(df.columns)})
print(f"{len(df)} rows, {len(df.columns)} columns")
`,
  },
  {
    name: 'aggregate_time',
    description: 'Total a value per date (e.g. weekly revenue across all regions).',
    params: z.object({ date: col, value: col }).strict(),
    requires: [],
    body: `
s = series_by_date(P["date"], P["value"])
out = pd.DataFrame({P["date"]: s.index.strftime("%Y-%m-%d"), P["value"]: s.values})
out_csv(out, f"{P['value']}_total_by_{P['date']}.csv")
years = (s.index - s.index[0]).days.values / 365.25
slope = float(np.polyfit(years, s.values, 1)[0]) if len(s) >= 3 else None
summary({"periods": len(s), "total": float(s.sum()), "first": str(s.index.min().date()),
         "last": str(s.index.max().date()), "mean": float(s.mean()),
         "first_value": float(s.iloc[0]), "last_value": float(s.iloc[-1]),
         "change": float(s.iloc[-1] - s.iloc[0]), "trend_per_year": slope})
print(f"{len(s)} periods from {s.index.min().date()} to {s.index.max().date()}, total {s.sum():.2f}")
print(f"First {s.iloc[0]:.2f}, last {s.iloc[-1]:.2f}" + (f"; linear trend {slope:+.3f} per year" if slope is not None else ""))
`,
  },
  {
    name: 'breakdown',
    description:
      'Per group: total of a value, share of the total, number of rows and average per row.',
    params: z.object({ group: col, value: col }).strict(),
    requires: [],
    body: `
agg = df.assign(**{P["group"]: df[P["group"]].astype(str)}).groupby(P["group"])[P["value"]].agg(["sum", "count", "mean"])
g = agg.rename(columns={"sum": P["value"]}).sort_values(P["value"], ascending=False).reset_index()
g["share"] = g[P["value"]] / g[P["value"]].sum()
g = g[[P["group"], P["value"], "share", "count", "mean"]]
out_csv(g, f"{P['value']}_by_{P['group']}.csv")
top = g.iloc[0]
top_mean = g.sort_values("mean", ascending=False).iloc[0]
summary({"groups": len(g), "total": float(g[P["value"]].sum()),
         "top_group": str(top[P["group"]]), "top_share": float(top["share"]),
         "top_group_by_mean": str(top_mean[P["group"]]), "top_mean": float(top_mean["mean"])})
print(f"Largest total: {top[P['group']]} ({top['share']:.0%} of the total, {int(top['count'])} rows).")
print(f"Highest average per row: {top_mean[P['group']]} ({top_mean['mean']:.2f}).")
print(g.to_string(index=False))
`,
  },
  {
    name: 'decompose',
    description:
      'Seasonal-trend decomposition (STL) of the per-date total: trend, seasonal, residual, seasonal strength, and a permutation test (p-value) for whether the seasonality is real.',
    params: z
      .object({
        date: col,
        value: col,
        period: z.number().int().min(2).max(366).default(52),
        /** Aggregate daily data to complete calendar weeks first (long daily series). */
        resample: z.enum(['week']).optional(),
      })
      .strict(),
    requires: ['statsmodels'],
    body:
      STL_HELPERS +
      `
s = series_by_date(P["date"], P["value"], resample=P.get("resample"))
if P.get("resample") == "week":
    print(f"Daily values summed to {len(s)} complete calendar weeks (Monday start) before decomposition.")
period = int(P["period"])
if len(s) < 2 * period:
    raise SystemExit(f"Need at least {2 * period} periods for period={period}; have {len(s)}.")
res, strength = stl_fit(s, period)
PERMUTATIONS = 999
p_value = permutation_p(s, period, PERMUTATIONS)
significant = p_value < ALPHA
parts = [("observed", s), ("trend", res.trend), ("seasonal", res.seasonal), ("residual", res.resid)]
long = pd.concat([pd.DataFrame({P["date"]: s.index.strftime("%Y-%m-%d"), "component": n, P["value"]: v.values}) for n, v in parts])
out_csv(long, f"{P['value']}_decomposition.csv")
amplitude = float((res.seasonal.max() - res.seasonal.min()) / 2)
peak = str(res.seasonal.idxmax().date())
# For yearly cycles the calendar month of the typical peak is the meaningful answer:
# the month where the seasonal component is highest on average across all years.
peak_month = None
if period in (12, 52):
    by_month = res.seasonal.groupby(res.seasonal.index.month).mean()
    peak_month = pd.Timestamp(2000, int(by_month.idxmax()), 1).strftime("%B")
summary({"period": period, "seasonal_strength": strength, "seasonal_amplitude": amplitude,
         "peak_date": peak, "peak_month": peak_month,
         "trend_change": float(res.trend.iloc[-1] - res.trend.iloc[0]),
         "p_value": p_value, "permutations": PERMUTATIONS, "alpha": ALPHA, "significant": significant})
if significant:
    print(f"Seasonality is statistically significant (permutation test, p = {p_value:.3f} < {ALPHA}).")
    where = f"peak in {peak_month}" if peak_month else f"peak {peak}"
    print(f"Seasonal amplitude {amplitude:.2f} (strength {strength:.3f}), {where}.")
else:
    print(f"No significant seasonality (permutation test, p = {p_value:.3f} >= {ALPHA}).")
    print(f"The decomposition still shows strength {strength:.3f}, but this is consistent with noise.")
`,
  },
  {
    name: 'seasonality_by_group',
    description:
      'Decompose each group separately, compare seasonal amplitude and strength, and test each group for significant seasonality (permutation test).',
    params: z
      .object({
        date: col,
        value: col,
        group: col,
        period: z.number().int().min(2).max(366).default(52),
        resample: z.enum(['week']).optional(),
      })
      .strict(),
    requires: ['statsmodels'],
    body:
      STL_HELPERS +
      `
period = int(P["period"])
PERMUTATIONS = 999
rows = []
for name, part in df.groupby(P["group"]):
    s = series_by_date(P["date"], P["value"], frame=part, resample=P.get("resample"))
    if len(s) < 2 * period:
        continue
    res, strength = stl_fit(s, period)
    p_value = permutation_p(s, period, PERMUTATIONS)
    rows.append({P["group"]: str(name),
                 "seasonal_amplitude": float((res.seasonal.max() - res.seasonal.min()) / 2),
                 "seasonal_strength": strength, "p_value": p_value, "significant": p_value < ALPHA})
if not rows:
    raise SystemExit(f"No group has at least {2 * period} periods.")
out = pd.DataFrame(rows).sort_values("seasonal_amplitude", ascending=False)
out["share_of_summed_amplitude"] = out["seasonal_amplitude"] / out["seasonal_amplitude"].sum()
out_csv(out, f"seasonality_by_{P['group']}.csv")
sig = out[out["significant"]]
top = sig.iloc[0] if len(sig) else None
summary({"groups": len(out), "significant_groups": [str(g) for g in sig[P["group"]]],
         "top_group": str(top[P["group"]]) if top is not None else None,
         "top_share_of_summed_amplitude": float(top["share_of_summed_amplitude"]) if top is not None else None,
         "permutations": PERMUTATIONS, "alpha": ALPHA})
if top is None:
    print("No group shows significant seasonality (permutation test, alpha 0.05).")
else:
    print(f"{top[P['group']]} drives the seasonality ({top['share_of_summed_amplitude']:.0%} of the summed seasonal amplitude).")
print(out.to_string(index=False))
`,
  },
  {
    name: 'correlate',
    description:
      'Association of a numeric target with other numeric columns: Pearson r, Spearman rho, permutation p-values (Holm-corrected for multiple tests). Columns that add up to the target are reported as components, not drivers.',
    params: z.object({ target: col, candidates: z.array(col).min(1).max(30) }).strict(),
    requires: [],
    body: `
PERMUTATIONS = 999
ALPHA = 0.05
target = P["target"]
num = df.apply(pd.to_numeric, errors="coerce")
cands = [c for c in P["candidates"] if c != target and c in num.columns]
# Columns that sum exactly to the target (e.g. casual + registered = cnt) explain it by
# construction; they are listed as components, not as drivers.
components = set()
y_all = num[target]
for i, a in enumerate(cands):
    for b in cands[i + 1:]:
        both = num[[a, b]].notna().all(axis=1) & y_all.notna()
        if both.sum() >= 8 and np.allclose(num.loc[both, a] + num.loc[both, b], y_all[both]):
            components.update([a, b])
rng = np.random.default_rng(20261020)
rows = []
for c in cands:
    d = num[[target, c]].dropna()
    if len(d) < 8 or d[c].std() == 0 or d[target].std() == 0:
        continue
    x = d[c].to_numpy(float) - d[c].mean()
    y = d[target].to_numpy(float) - d[target].mean()
    denom = float(np.sqrt((x ** 2).sum() * (y ** 2).sum()))
    r = float((x * y).sum() / denom)
    rho = float(d[c].rank().corr(d[target].rank()))
    exceed = sum(abs(float((rng.permutation(x) * y).sum()) / denom) >= abs(r) - 1e-12 for _ in range(PERMUTATIONS))
    rows.append({"variable": c, "n": len(d), "pearson_r": r, "spearman_rho": rho,
                 "r_squared": r * r, "p_value": (exceed + 1) / (PERMUTATIONS + 1),
                 "component": c in components})
if not rows:
    raise SystemExit("No numeric column with enough paired values to correlate.")
out = pd.DataFrame(rows)
# Holm step-down correction over the tested non-component variables.
tested = out[~out["component"]].sort_values("p_value")
m = len(tested)
holm, running = {}, 0.0
for k, (idx, p) in enumerate(tested["p_value"].items()):
    running = max(running, min(1.0, (m - k) * p))
    holm[idx] = running
out["p_holm"] = pd.Series(holm)
out["significant"] = out["p_holm"].notna() & (out["p_holm"] < ALPHA)
out["direction"] = np.where(out["pearson_r"] >= 0, "positive", "negative")
out["role"] = np.where(out["component"], "component of " + target,
                       np.where(out["significant"], "significant", "not significant"))
out = out.reindex(out["pearson_r"].abs().sort_values(ascending=False).index)
out_csv(out[["variable", "n", "pearson_r", "spearman_rho", "r_squared", "p_value", "p_holm",
             "significant", "direction", "component", "role"]], f"correlations_with_{target}.csv")
sig = out[out["significant"]]
top = sig.iloc[0] if len(sig) else None
summary({"target": target, "tested": int(m), "permutations": PERMUTATIONS, "alpha": ALPHA,
         "components": sorted(components),
         "significant_variables": [str(v) for v in sig["variable"]],
         "top_variable": str(top["variable"]) if top is not None else None,
         "top_r": float(top["pearson_r"]) if top is not None else None,
         "top_direction": str(top["direction"]) if top is not None else None})
if components:
    print(f"{', '.join(sorted(components))} add up to {target}; they are components, not drivers.")
if top is None:
    print(f"No variable is significantly associated with {target} (permutation test, Holm-corrected).")
else:
    print(f"Strongest association with {target}: {top['variable']} (r = {top['pearson_r']:+.2f}, "
          f"{top['direction']}; p (Holm) = {top['p_holm']:.3f}, n = {int(top['n'])}).")
    print(f"{len(sig)} of {m} variables are significant. Correlation is not causation.")
print(out.to_string(index=False))
`,
  },
  {
    name: 'forecast',
    description:
      'Holt-Winters forecast of the per-date total for a horizon, with a backtest on the last periods compared against a naive (seasonal) forecast, and an approximate 95% band from the backtest error.',
    params: z
      .object({
        date: col,
        value: col,
        /** Seasonal period; omit for a trend-only model. */
        period: z.number().int().min(2).max(366).optional(),
        horizon: z.number().int().min(1).max(366),
        resample: z.enum(['week']).optional(),
      })
      .strict(),
    requires: ['statsmodels'],
    body: `
from statsmodels.tsa.holtwinters import ExponentialSmoothing
s = series_by_date(P["date"], P["value"], resample=P.get("resample"))
period = P.get("period")
H = int(P["horizon"])
if period and len(s) < 2 * period + H:
    raise SystemExit(f"Need at least {2 * period + H} periods for a seasonal backtest; have {len(s)}.")
if len(s) < 3 * H:
    raise SystemExit(f"Need at least {3 * H} periods for a {H}-period backtest; have {len(s)}.")
def fit(series):
    kw = {"seasonal": "add", "seasonal_periods": period} if period else {}
    return ExponentialSmoothing(series, trend="add", **kw).fit()
train, test = s.iloc[:-H], s.iloc[-H:]
pred = fit(train).forecast(H)
mae = float(np.mean(np.abs(pred.values - test.values)))
mape = float(np.mean(np.abs((pred.values - test.values) / test.values))) if (test.values != 0).all() else None
rmse = float(np.sqrt(np.mean((pred.values - test.values) ** 2)))
# Naive benchmark: the value one season earlier (or the last value without seasons).
naive = s.shift(period).iloc[-H:].values if period else np.repeat(train.iloc[-1], H)
naive_mae = float(np.mean(np.abs(naive - test.values)))
skill = 1.0 - mae / naive_mae if naive_mae > 0 else None
fc = fit(s).forecast(H)
# Future dates continue the series' own spacing; monthly data stays on month starts.
gap = (s.index[-1] - s.index[-2]).days
if 27 <= gap <= 32:
    future = pd.date_range(s.index[-1] + pd.offsets.MonthBegin(1), periods=H, freq="MS")
else:
    future = pd.DatetimeIndex([s.index[-1] + pd.Timedelta(days=gap) * (i + 1) for i in range(H)])
band = 1.96 * rmse
def frame(kind, idx, vals, lo=None, hi=None):
    return pd.DataFrame({P["date"]: pd.DatetimeIndex(idx).strftime("%Y-%m-%d"), "kind": kind,
                         P["value"]: np.asarray(vals, dtype=float),
                         "lower": lo if lo is not None else np.nan, "upper": hi if hi is not None else np.nan})
# Recent history only, so the forecast stays visible next to 60 years of data.
hist = s.iloc[-max(4 * (period or 0), 4 * H, 24):]
out = pd.concat([frame("actual", hist.index, hist.values), frame("backtest", test.index, pred.values),
                 frame("forecast", future, fc.values, fc.values - band, fc.values + band)])
out_csv(out, f"{P['value']}_forecast.csv")
beats = naive_mae > 0 and mae < naive_mae
summary({"model": "Holt-Winters (additive trend" + (", additive seasonal" if period else "") + ")",
         "period": period, "horizon": H, "backtest_periods": H, "backtest_mae": mae,
         "backtest_mape": mape, "backtest_rmse": rmse, "naive_mae": naive_mae, "skill": skill,
         "beats_naive": bool(beats), "last_actual": float(s.iloc[-1]),
         "last_date": str(s.index[-1].date()), "forecast_end": float(fc.values[-1]),
         "forecast_end_date": str(future[-1].date()), "band_95": band})
print(f"Forecast for the next {H} periods: {fc.values[-1]:.2f} by {future[-1].date()} "
      f"(last actual {s.iloc[-1]:.2f} on {s.index[-1].date()}); approximate 95% band ±{band:.2f}.")
print(f"Backtest on the last {H} periods: MAE {mae:.2f}" + (f" ({mape:.1%})" if mape is not None else "")
      + f" vs {naive_mae:.2f} for the naive {'seasonal ' if period else ''}forecast: "
      + (f"{skill:.0%} better." if beats else "NOT better than the naive forecast; treat this forecast with caution."))
`,
  },
];

export function getRecipe(name: string): Recipe | undefined {
  return RECIPES.find((r) => r.name === name);
}

/** Full program for a recipe, or the validation error for its params. */
export function buildRecipeCode(
  recipe: Recipe,
  params: unknown,
  capabilityPaths: readonly string[] = [],
): { code: string } | { error: string } {
  const parsed = recipe.params.safeParse(params ?? {});
  if (!parsed.success)
    return { error: `Invalid params for ${recipe.name}: ${parsed.error.message}` };
  return { code: prelude(parsed.data, capabilityPaths) + recipe.body };
}
