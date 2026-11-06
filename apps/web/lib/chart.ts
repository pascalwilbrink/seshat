/** Stable series → design-token mapping and text helpers shared by every chart. */

/** Semantic colour tokens from `app/globals.css` a series may use. Never a raw colour. */
export type ChartToken = 'primary' | 'info' | 'success' | 'warning' | 'destructive' | 'muted-foreground';

/** Differentiators besides colour, so series stay distinguishable without it. */
export const CHART_PATTERNS = ['solid', 'diagonal', 'dots', 'cross'] as const;
export type ChartPattern = (typeof CHART_PATTERNS)[number];

/** Line dash arrays that go with {@link CHART_PATTERNS} by index. */
export const CHART_DASHES: (string | undefined)[] = [undefined, '6 3', '2 3', '10 3 2 3'];

/**
 * One token per channel and per MCP call outcome. Use these keys as series keys so a series keeps the same
 * colour on every chart; anything else must pass an explicit `token`.
 */
export const SERIES_TOKENS: Record<string, ChartToken> = {
  ui: 'primary',
  api: 'info',
  mcp: 'success',
  read: 'primary',
  retrieved: 'info',
  success: 'success',
  invalid_arguments: 'warning',
  forbidden: 'warning',
  not_found: 'info',
  unknown_tool: 'muted-foreground',
  internal_error: 'destructive',
  error: 'destructive',
};

export interface ChartSeries {
  /** Key of the value in each data row. */
  key: string;
  label: string;
  /** Defaults to the stable mapping in {@link SERIES_TOKENS}, then `primary`. */
  token?: ChartToken;
}

export interface ResolvedSeries extends ChartSeries {
  token: ChartToken;
  pattern: ChartPattern;
  dash: string | undefined;
  color: string;
}

export const tokenColor = (token: ChartToken) => `var(--${token})`;

/** Resolve colour token, pattern and dash for each series; the pattern follows the series order. */
export function resolveSeries(series: ChartSeries[]): ResolvedSeries[] {
  return series.map((s, i) => {
    const token = s.token ?? SERIES_TOKENS[s.key] ?? 'primary';
    return { ...s, token, pattern: CHART_PATTERNS[i % CHART_PATTERNS.length]!, dash: CHART_DASHES[i % CHART_DASHES.length], color: tokenColor(token) };
  });
}

const numberFormat = new Intl.NumberFormat('en-US');
/** The one number format used by tooltips, summaries and tables so values match everywhere. */
export const formatCount = (value: number) => numberFormat.format(value);

export type ChartRow = Record<string, string | number>;

const num = (v: string | number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const seriesTotal = (rows: ChartRow[], key: string) => rows.reduce((sum, r) => sum + num(r[key]), 0);
export const isEmptyData = (rows: ChartRow[], series: ChartSeries[]) => rows.length === 0 || series.every((s) => seriesTotal(rows, s.key) === 0);

/** Plain-language summary: totals per series and the busiest point. */
export function summarizeSeries(rows: ChartRow[], series: ChartSeries[], xKey: string, unit = 'events'): string {
  if (isEmptyData(rows, series)) return `No ${unit} in this period.`;
  const totals = series.map((s) => `${s.label} ${formatCount(seriesTotal(rows, s.key))}`).join(', ');
  const all = rows.reduce((sum, r) => sum + series.reduce((a, s) => a + num(r[s.key]), 0), 0);
  let peak = rows[0]!;
  let peakValue = -1;
  for (const r of rows) {
    const v = series.reduce((a, s) => a + num(r[s.key]), 0);
    if (v > peakValue) {
      peak = r;
      peakValue = v;
    }
  }
  return `${formatCount(all)} ${unit} across ${rows.length} ${rows.length === 1 ? 'point' : 'points'}: ${totals}. Highest: ${String(peak[xKey])} with ${formatCount(peakValue)}.`;
}
