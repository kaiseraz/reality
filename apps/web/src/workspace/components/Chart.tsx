import { useEffect, useRef, useState } from 'react';
import { api, type RowsPage } from '../../api.ts';
import type { RendererProps } from '../context.ts';
import { buildVegaLiteSpec, type ChartProps } from './chart-spec.ts';
import type { Config } from 'vega-lite';
import { useResolvedTheme } from '../../ui/hooks.ts';

/** Chart colours from the page's theme tokens: transparent background, quiet axes. */
function themedChartConfig(): Config {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const text = v('--muted') || '#5d5d5d';
  const grid = v('--border') || '#e5e5e5';
  return {
    background: 'transparent',
    font: 'ui-sans-serif, -apple-system, Segoe UI, system-ui, sans-serif',
    view: { stroke: null },
    axis: {
      labelColor: text,
      titleColor: text,
      gridColor: grid,
      domainColor: grid,
      tickColor: grid,
      labelFontSize: 11,
      titleFontSize: 11,
      titleFontWeight: 500 as const,
    },
    legend: { labelColor: text, titleColor: text },
    header: { labelColor: text, titleColor: text },
    range: { category: ['#10a37f', '#6e7bf2', '#f0a03c', '#e0607e', '#3ab1cf', '#9b8cf2'] },
    line: { strokeWidth: 1.6 },
    mark: { color: '#10a37f' },
  };
}

export function Chart({ instance }: RendererProps) {
  const theme = useResolvedTheme();
  const binding = instance.bindings.rows;
  const props = instance.props as unknown as ChartProps & { maxRows?: number };
  const maxRows = props.maxRows ?? 5000;
  const host = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<RowsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const artifactId = binding?.kind === 'artifact' ? binding.artifact.id : null;
  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    api
      .rows(artifactId, { offset: 0, limit: maxRows })
      .then((p) => !cancelled && setPage(p))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [artifactId, maxRows]);

  // Re-render when data or any chart prop changes; props are small, so JSON is a fine key.
  const propsKey = JSON.stringify(props);
  useEffect(() => {
    if (!page || !host.current) return;
    let finalize: (() => void) | undefined;
    let cancelled = false;
    const el = host.current;
    void import('vega-embed').then(({ default: embed }) =>
      embed(el, buildVegaLiteSpec(JSON.parse(propsKey) as ChartProps, page.rows), {
        actions: false,
        renderer: 'svg',
        config: themedChartConfig(),
      })
        .then((result) => {
          if (cancelled) result.finalize();
          else finalize = () => result.finalize();
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))),
    );
    return () => {
      cancelled = true;
      finalize?.();
    };
  }, [page, propsKey, theme]);

  if (!artifactId) return <p className="muted pad">No dataset bound.</p>;
  if (error)
    return (
      <p role="alert" className="pad">
        {error}
      </p>
    );
  return (
    <div className="chart">
      <div ref={host} className="chart-host" aria-label={props.title} />
      {page && page.total > page.rows.length && (
        <p className="muted pad">
          Showing the first {page.rows.length.toLocaleString()} of {page.total.toLocaleString()}{' '}
          rows.
        </p>
      )}
    </div>
  );
}
