# ADR 0011: Correlation and forecasting as built-in recipes

Status: accepted

## Context

Without an AI model, Reality could answer four kinds of questions: totals over time, group
comparison, seasonality and SQL. Two of the most common data questions were missing: "what is
X related to?" and "how will X continue?". Both are easy to answer wrongly. Correlations of
components with their sum look like strong drivers. Forecasts without a backtest cannot be
judged.

## Decisions

1. **Correlation (`correlate`, base sandbox, numpy only).**
   - Computes Pearson r and Spearman rho for up to 30 numeric columns.
   - Two-sided permutation p-values (999 shuffles, seeded), with Holm correction across all
     tested variables.
   - Columns that add up exactly to the target (`casual + registered = cnt`) are reported as
     components, not drivers, and are excluded from testing.
   - The planner excludes ids, calendar parts and integer codes with more than two values.
     Those are categories and go to the group comparison. Binary flags are kept.
   - Each result is labelled "correlation is not causation".
2. **Forecast (`forecast`, statsmodels capability).**
   - Holt-Winters with additive trend, plus additive seasonality when the series has a period.
   - Before forecasting, the model is fitted without the last H periods, and its error on those
     periods is compared with a naive forecast (one season earlier, or the last value).
   - The step states in plain words when the model does not beat the naive forecast.
   - The 95% band is ±1.96·RMSE of the backtest and is labelled approximate.
   - A seasonal model needs two full cycles before the backtest window. If that does not fit,
     the planner refuses and says why. Two years of daily data cannot support a yearly-cycle
     forecast, and the planner says so rather than producing a number.
   - The horizon comes from the request ("next 24 months", "nächsten 6 Wochen"). By default it
     is one cycle, and it is shortened, with a note, when the backtest would not fit.
3. **Checks see the claim.** The verifier passes a step's own summary to its check as `CLAIM`.
   - `correlation_matches` recomputes every Pearson r and pair count from the raw CSV with
     plain Python. It also confirms that the claimed strongest variable is the significant one
     with the largest |r|.
   - `forecast_backtest_matches` confirms that the reported history is exactly the latest raw
     totals. It then recomputes the backtest MAE and the naive MAE, and checks the
     "beats naive" claim.
   - Neither check reuses recipe code.
4. **Capability layers are unique per installation.** A real-data run found that two Reality
   instances on one Docker host shared the volume `reality-cap-<id>-<version>`. A reinstall by
   one instance emptied the layer another was using. Volume names now carry a random suffix,
   and only the instance's own previous layer is removed.

## Consequences

- With the CO₂ record, the 24-month forecast has a backtest MAE of 0.39 ppm, against 2.49 ppm
  for the naive seasonal forecast. With the bike data, perceived temperature is the strongest
  driver (r = 0.63), and `casual` and `registered` are flagged as components.
- Prediction intervals are approximate, not model-based.
- Correlation is linear or rank-based. Interactions and confounding are not modelled.
