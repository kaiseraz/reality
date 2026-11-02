import {
  chooseGroupColumn,
  chooseValueColumn,
  inferFrequency,
  isCodeLike,
  isIdLike,
  isTimePart,
  mentions,
  type Column,
  type Frequency,
} from '@reality/workspace';
import { PlannerError, type Planner, type PlannerInput, type PlannerOutput } from './planner.ts';
import { labIntent, labPlan } from '../lab/plan.ts';

export const DECOMPOSITION_NEED = 'time-series decomposition';
export const DECOMPOSITION_CAPABILITY = 'statsmodels';
export const FORECAST_NEED = 'time-series forecasting';

const CORRELATION =
  /correlat|relationship|associat|influenc|affect|impact|\bfactors?\b|\bdrivers\b|related to|depends? on|zusammenhang|einfluss|korrel|faktoren/i;
const FORECAST =
  /forecast|predict|projection|prognos|vorhersag|outlook|future|zukunft|\bnext\s+\d*\s*(days?|weeks?|months?|quarters?|years?)|nächsten?\s+\d*\s*(tage|wochen|monate|quartale|jahre)/i;

const UNIT_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30.44,
  quarter: 91.31,
  year: 365.25,
};
const GERMAN_UNITS: Record<string, string> = {
  tage: 'day',
  wochen: 'week',
  monate: 'month',
  quartale: 'quarter',
  jahre: 'year',
};

/** Words that say "research this" but are no help to a literature search engine. */
const RESEARCH_FILLER = new Set(
  (
    'what which who how why when where is are was were does do did the a an of in on to for and or ' +
    'about known know studies study papers paper literature research evidence find show tell me us ' +
    'there any recent latest current say says said effect effects between ' +
    'was wie warum welche gibt es ist sind über zu zum zur der die das den dem ein eine und oder ' +
    'studien studie literatur forschung bekannt weiß man aktuelle neueste zeigen sagt'
  ).split(' '),
);

/** The topic words of a research question, for a literature search; '' if nothing is left. */
export function researchQuery(request: string): string {
  const words = request.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  const kept = words.filter((w) => w.length > 1 && !RESEARCH_FILLER.has(w));
  return kept.slice(0, 12).join(' ');
}

/** Without data, the built-in planner can still research: literature plus the owner's notes. */
function researchPlan(request: string, query: string, model: string): PlannerOutput {
  const draft = {
    goal: request,
    constraints: [],
    requiredOutputs: [
      'Relevant scholarly works with abstracts',
      'Matching passages from your notes',
    ],
    resources: [],
    risks: [
      'Rule-based plan (no AI model configured): sources are found and listed, but no answer is written from them. With a model, a cited answer is added and its quotes are checked.',
      `Search terms taken from the request: "${query}".`,
    ],
    acceptanceCriteria: [
      {
        id: 'sources',
        description: 'The listed works are relevant to the question (judged by a person)',
        checkType: 'human',
      },
    ],
    workflow: [
      {
        id: 'literature',
        description: `Search the literature for "${query}"`,
        agent: 'research-agent',
        dependsOn: [],
        recipe: { name: 'literature', params: { query, limit: 8 } },
      },
      {
        id: 'knowledge',
        description: `Search your knowledge sources for "${query}"`,
        agent: 'research-agent',
        dependsOn: [],
        recipe: { name: 'knowledge', params: { query, limit: 6 } },
      },
      {
        id: 'verify',
        description: 'Check the result against the acceptance criteria',
        agent: 'verification-agent',
        dependsOn: ['literature', 'knowledge'],
      },
    ],
    missingCapabilities: [],
    candidateWorkspaces: ['research'],
  };
  return { draft, model, usage: { inputTokens: 0, outputTokens: 0 } };
}

/** "next 24 months" / "nächsten 6 Monate", in days; undefined if the request names no horizon. */
export function requestedHorizonDays(request: string): number | undefined {
  const en = /\bnext\s+(\d+)\s+(day|week|month|quarter|year)s?/i.exec(request);
  if (en?.[1] && en[2]) return Number(en[1]) * (UNIT_DAYS[en[2].toLowerCase()] ?? 1);
  const de = /nächsten?\s+(\d+)\s+(tage|wochen|monate|quartale|jahre)/i.exec(request);
  const unit = de?.[2] ? GERMAN_UNITS[de[2].toLowerCase()] : undefined;
  if (de?.[1] && unit) return Number(de[1]) * (UNIT_DAYS[unit] ?? 1);
  return undefined;
}

/** Numeric columns to correlate with the target: no ids, calendar parts or multi-valued codes. */
export function correlationCandidates(
  columns: readonly Column[],
  rowCount: number,
  target: string,
): string[] {
  return columns
    .filter(
      (c) =>
        c.type === 'number' &&
        c.name !== target &&
        !isIdLike(c, rowCount) &&
        !isTimePart(c) &&
        !(isCodeLike(c) && (c.distinct ?? 0) > 2),
    )
    .map((c) => c.name)
    .slice(0, 30);
}

/**
 * Forecast horizon and backtest feasibility, in periods of the (possibly resampled) series.
 * A seasonal model needs two full cycles to train on before the backtest window.
 */
export function planForecast(
  frequency: Frequency,
  length: number,
  requestedDays: number | undefined,
): { horizon: number; period?: number; note?: string } | { refused: string } {
  const spacing = frequency.resample === 'week' ? 7 : frequency.spacingDays;
  const period = frequency.period;
  const wanted = requestedDays
    ? Math.max(1, Math.round(requestedDays / spacing))
    : (period ?? Math.min(12, Math.floor(length / 4)));
  const cap = Math.min(period ? length - 2 * period : length, Math.floor(length / 3));
  if (cap < 1) {
    return {
      refused: period
        ? `No forecast: a seasonal model (cycle of ${period} periods) must learn from two full cycles (${2 * period} periods) and then be tested on further periods, but the data has only ${length}. More history is needed.`
        : `Too few periods (${length}) to forecast and test the forecast.`,
    };
  }
  const horizon = Math.min(wanted, cap);
  return {
    horizon,
    ...(period ? { period } : {}),
    ...(horizon < wanted
      ? {
          note: `Forecast horizon shortened to ${horizon} periods (requested ${wanted}): the backtest must fit into the data after two full cycles.`,
        }
      : {}),
  };
}

const SEASONAL =
  /season|saison|pattern|periodic|cycl|trend|decompos|wöchentlich|weekly|monthly|yearly|annual/i;
/** Seasonality words proper; "monthly" etc. only describe the data in a forecast request. */
const SEASONAL_STRICT = /season|saison|pattern|periodic|cycl|decompos/i;
const GROUPING =
  /\bwhich\b|\bby\b|\bper\b|\beach\b|region|segment|categor|group|drive|driv|compare|breakdown|split|\btop\b|welche/i;

/**
 * Deterministic planner used when no AI model is configured. It plans only what the
 * built-in recipes can actually do, from the real schema of the attached dataset, and
 * states its assumptions as risks. It never pretends to understand more than that.
 */
export class RuleBasedPlanner implements Planner {
  readonly name = 'rule-based-planner';

  async propose(input: PlannerInput): Promise<PlannerOutput> {
    const dataset = input.datasets?.at(-1);
    if (!dataset) {
      const lab = labIntent(input.request);
      if (lab) {
        return labPlan(
          lab.engine,
          lab.params,
          input.request,
          input.availableCapabilities ?? [],
          this.name,
        );
      }
      const query = researchQuery(input.request);
      if (!query) {
        throw new PlannerError(
          'Attach a CSV file to analyse data, or ask a research question (e.g. "What is known about …?").',
          false,
        );
      }
      return researchPlan(input.request, query, this.name);
    }
    const request = input.request;
    const sql = extractSql(request);
    if (sql) return sqlPlan(request, sql, dataset, input.availableCapabilities ?? [], this.name);
    const cols = dataset.columns;
    const date = cols.find((c) => c.type === 'date');
    // Shared with the workspace templates: never ids, codes or calendar parts as values;
    // columns count as mentioned only as whole words ("seasonal" ≠ "season").
    const value = chooseValueColumn(cols, dataset.rowCount, request);
    const group = chooseGroupColumn(cols, request);
    const frequency = date ? inferFrequency(date) : undefined;
    const period = frequency?.period;

    // Narrowed bundles, so later code needs no assertions.
    const series = date && value ? { date: date.name, value: value.name } : undefined;
    const forecastQuestion = FORECAST.test(request);
    const wantsSeason =
      (forecastQuestion ? SEASONAL_STRICT : SEASONAL).test(request) && series !== undefined;
    const decomp =
      wantsSeason && series && period !== undefined
        ? { ...series, period, ...(frequency?.resample ? { resample: frequency.resample } : {}) }
        : undefined;
    const grouped =
      group && value && (GROUPING.test(request) || mentions(request, group.name))
        ? { group: group.name, value: value.name }
        : undefined;
    // Per-group decomposition needs one series per group (panel data: every group on every date).
    const panel =
      date !== undefined &&
      group !== undefined &&
      dataset.rowCount === (date.distinct ?? 0) * (group.distinct ?? 0);
    const hasDecomposition = (input.availableCapabilities ?? []).includes(DECOMPOSITION_CAPABILITY);
    const wantsCorrelation = CORRELATION.test(request) && value !== undefined;
    const wantsForecast = forecastQuestion && series !== undefined;
    // With a correlation question, compare groups only if the request names the group column.
    const breakdown =
      grouped && (!wantsCorrelation || mentions(request, grouped.group)) ? grouped : undefined;

    const steps: Record<string, unknown>[] = [];
    const criteria: Record<string, unknown>[] = [];
    const risks: string[] = [
      `Rule-based plan (no AI model configured): it only uses built-in analysis recipes.`,
      ...(dataset.notes ?? []).map((n) => `Data preparation: ${n}`),
      ...(value
        ? [
            `Analysing "${value.name}"${mentions(request, value.name) ? ' (named in the request)' : ' (chosen automatically; name a column in your request to choose another)'}.`,
          ]
        : []),
      ...(breakdown ? [`Grouping by "${breakdown.group}".`] : []),
    ];
    const missing: { need: string }[] = [];
    /** One acquisition step for statsmodels, shared by decomposition and forecasting. */
    const acquireStatsmodels = (need: string): string[] => {
      if (hasDecomposition) return [];
      if (!steps.some((st) => st.id === 'acquire')) {
        missing.push({ need });
        steps.push({
          id: 'acquire',
          description: `Acquire and test a ${need} library`,
          agent: 'capability-agent',
          dependsOn: [],
          capability: need,
        });
      }
      return ['acquire'];
    };

    steps.push({
      id: 'profile',
      description: `Profile ${dataset.filename}: column types, nulls, ranges`,
      agent: 'analysis-agent',
      dependsOn: [],
      recipe: { name: 'profile', params: {} },
    });
    criteria.push({
      id: 'rows',
      description: `All ${dataset.rowCount} rows of ${dataset.filename} are read`,
      checkType: 'recompute',
      check: { name: 'row_count', params: { expected: dataset.rowCount } },
    });

    if (date && value) {
      steps.push({
        id: 'aggregate',
        description: `Total ${value.name} per ${date.name}`,
        agent: 'analysis-agent',
        dependsOn: ['profile'],
        recipe: { name: 'aggregate_time', params: { date: date.name, value: value.name } },
      });
      criteria.push({
        id: 'totals',
        description: `Per-${date.name} totals add up to the dataset total of ${value.name}`,
        checkType: 'recompute',
        check: {
          name: 'totals_match',
          params: { step: 'aggregate', date: date.name, value: value.name },
        },
      });
    }

    if (wantsSeason && !decomp) {
      risks.push(
        frequency?.label === 'irregular'
          ? 'Dates are irregularly spaced; a seasonal decomposition needs a regular series, so seasonality is not analysed.'
          : `Too few distinct dates (${date?.distinct ?? 0}${frequency ? `, ${frequency.label}` : ''}) for a seasonal decomposition (two full cycles needed); seasonality is not analysed.`,
      );
    }
    if (decomp && frequency) {
      risks.push(
        'Seasonality counts as real only if a permutation test gives p < 0.05; weak seasonality (amplitude well below the noise level) can go undetected.',
        `Seasonal period ${decomp.period} (${frequency.periodLabel}): ${frequency.label} data, ${date?.distinct} dates over ${(frequency.spanDays / 365.25).toFixed(1)} years.`,
      );
      const capDeps = acquireStatsmodels(DECOMPOSITION_NEED);
      steps.push({
        id: 'decompose',
        description: `Decompose total ${decomp.value} into trend, seasonal and residual (STL, period ${decomp.period})`,
        agent: 'analysis-agent',
        dependsOn: ['aggregate', ...capDeps],
        recipe: {
          name: 'decompose',
          params: decomp,
        },
      });
      criteria.push({
        id: 'decomposition',
        description: 'Trend + seasonal + residual reconstruct the observed series exactly',
        checkType: 'recompute',
        check: {
          name: 'decomposition_reconstructs',
          params: {
            step: 'decompose',
            date: decomp.date,
            value: decomp.value,
            ...(decomp.resample ? { resample: decomp.resample } : {}),
          },
        },
      });
    }

    if (breakdown) {
      const grouped = breakdown;
      steps.push({
        id: 'breakdown',
        description: `Total ${grouped.value} per ${grouped.group} and share of total`,
        agent: 'analysis-agent',
        dependsOn: ['profile'],
        recipe: { name: 'breakdown', params: grouped },
      });
      criteria.push({
        id: 'groups',
        description: `${grouped.group} totals add up to the dataset total`,
        checkType: 'recompute',
        check: {
          name: 'breakdown_sums',
          params: { step: 'breakdown', ...grouped },
        },
      });
      if (decomp && !panel) {
        risks.push(
          `"${grouped.group}" is not a separate series per date (one row per date), so seasonality is not compared per ${grouped.group}; the breakdown compares totals and averages instead.`,
        );
      }
      if (decomp && panel) {
        steps.push({
          id: 'season_by_group',
          description: `Compare seasonal amplitude per ${grouped.group} (which ${grouped.group} drives the seasonality)`,
          agent: 'analysis-agent',
          dependsOn: ['decompose', 'breakdown'],
          recipe: {
            name: 'seasonality_by_group',
            params: { ...decomp, group: grouped.group },
          },
        });
      }
    }

    if (wantsCorrelation && value) {
      const candidates = correlationCandidates(cols, dataset.rowCount, value.name);
      if (candidates.length === 0) {
        risks.push(`No other numeric column to correlate with "${value.name}".`);
      } else {
        risks.push(
          `Correlation of "${value.name}" with ${candidates.length} numeric columns (${candidates.join(', ')}); significance by permutation test with Holm correction. Correlation is not causation.`,
        );
        steps.push({
          id: 'correlate',
          description: `Correlate ${value.name} with the other numeric columns`,
          agent: 'analysis-agent',
          dependsOn: ['profile'],
          recipe: { name: 'correlate', params: { target: value.name, candidates } },
        });
        criteria.push({
          id: 'correlations',
          description: `Every correlation with ${value.name} is re-computed from the raw data`,
          checkType: 'recompute',
          check: {
            name: 'correlation_matches',
            params: { step: 'correlate', target: value.name, candidates },
          },
        });
      }
    }

    if (wantsForecast && series) {
      // Complete calendar weeks for resampled daily data, otherwise one period per date.
      const length =
        frequency?.resample === 'week'
          ? Math.floor((frequency.spanDays + 1) / 7) - 1
          : (date?.distinct ?? 0);
      const fp =
        frequency && frequency.label !== 'irregular'
          ? planForecast(frequency, length, requestedHorizonDays(request))
          : { refused: 'Dates are irregularly spaced; a forecast needs a regular series.' };
      if ('refused' in fp) {
        risks.push(fp.refused);
      } else {
        if (fp.note) risks.push(fp.note);
        risks.push(
          `Forecast of ${fp.horizon} periods with Holt-Winters${fp.period ? ` (period ${fp.period})` : ' (trend only)'}; it is first tested on the last ${fp.horizon} known periods against a naive forecast. The 95% band is approximate (from the backtest error).`,
        );
        const capDeps = acquireStatsmodels(decomp ? DECOMPOSITION_NEED : FORECAST_NEED);
        const params = {
          ...series,
          horizon: fp.horizon,
          ...(fp.period ? { period: fp.period } : {}),
          ...(frequency?.resample ? { resample: frequency.resample } : {}),
        };
        steps.push({
          id: 'forecast',
          description: `Forecast ${series.value} for the next ${fp.horizon} periods, with a backtest`,
          agent: 'analysis-agent',
          dependsOn: ['aggregate', ...capDeps],
          recipe: { name: 'forecast', params },
        });
        criteria.push({
          id: 'backtest',
          description:
            'Backtest error and the naive-forecast comparison are re-computed from the raw data',
          checkType: 'recompute',
          check: { name: 'forecast_backtest_matches', params: { step: 'forecast', ...params } },
        });
      }
    }

    steps.push({
      id: 'verify',
      description: 'Check every result against the acceptance criteria',
      agent: 'verification-agent',
      dependsOn: steps.map((s) => s.id as string),
    });

    if (!value) risks.push('No numeric column found; only profiling is possible.');

    const draft = {
      goal: request,
      constraints: [],
      requiredOutputs: steps
        .filter((s) => s.agent === 'analysis-agent')
        .map((s) => s.description as string),
      resources: [],
      risks,
      acceptanceCriteria: criteria,
      workflow: steps,
      missingCapabilities: missing,
      candidateWorkspaces: ['data-analysis'],
    };
    return { draft, model: this.name, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

export const SQL_NEED = 'sql queries';
export const SQL_CAPABILITY = 'mcp-server-motherduck';

/** The SQL statement in a request, from its first SELECT/WITH to the end (or a fence). */
export function extractSql(request: string): string | undefined {
  const fenced = /```(?:sql)?\s*([\s\S]+?)```/i.exec(request)?.[1];
  const text = fenced ?? request;
  const m = /\b(select|with)\b[\s\S]*\bfrom\b[\s\S]*/i.exec(text);
  return m ? m[0].trim().replace(/;\s*$/, '') : undefined;
}

function sqlPlan(
  request: string,
  sql: string,
  dataset: NonNullable<PlannerInput['datasets']>[number],
  available: string[],
  model: string,
): PlannerOutput {
  const hasSql = available.includes(SQL_CAPABILITY);
  const steps: Record<string, unknown>[] = [
    {
      id: 'profile',
      description: `Profile ${dataset.filename}: column types, nulls, ranges`,
      agent: 'analysis-agent',
      dependsOn: [],
      recipe: { name: 'profile', params: {} },
    },
  ];
  if (!hasSql) {
    steps.push({
      id: 'acquire',
      description: 'Acquire and test a SQL query engine (MCP server)',
      agent: 'capability-agent',
      dependsOn: [],
      capability: SQL_NEED,
    });
  }
  steps.push(
    {
      id: 'query',
      description: `Run the SQL query on ${dataset.filename} (table "data")`,
      agent: 'analysis-agent',
      dependsOn: hasSql ? [] : ['acquire'],
      tool: { capability: SQL_CAPABILITY, name: 'execute_query', args: { sql } },
    },
    {
      id: 'verify',
      description: 'Check the result against an independent re-computation',
      agent: 'verification-agent',
      dependsOn: hasSql ? ['profile', 'query'] : ['profile', 'acquire', 'query'],
    },
  );
  const draft = {
    goal: request,
    constraints: ['Read-only: only a single SELECT (or WITH … SELECT) statement is executed'],
    requiredOutputs: ['Query result table'],
    resources: [],
    risks: [
      'Rule-based plan (no AI model configured): it runs your SQL as written.',
      `Your CSV is available as table "data" (DuckDB dialect); columns: ${dataset.columns.map((c) => c.name).join(', ')}.`,
      'Results are limited to 10,000 rows.',
      'The result is re-computed with SQLite; queries using DuckDB-only syntax are reported as not verified.',
    ],
    acceptanceCriteria: [
      {
        id: 'rows',
        description: `All ${dataset.rowCount} rows of ${dataset.filename} are read`,
        checkType: 'recompute',
        check: { name: 'row_count', params: { expected: dataset.rowCount } },
      },
      {
        id: 'sql',
        description: 'The query result matches an independent re-computation',
        checkType: 'recompute',
        check: { name: 'sql_result_matches', params: { step: 'query', sql } },
      },
    ],
    workflow: steps,
    missingCapabilities: hasSql ? [] : [{ need: SQL_NEED }],
    candidateWorkspaces: ['data-analysis'],
  };
  return { draft, model, usage: { inputTokens: 0, outputTokens: 0 } };
}
