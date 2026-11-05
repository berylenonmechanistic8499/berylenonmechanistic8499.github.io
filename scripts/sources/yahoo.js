// Yahoo Finance fills the gaps where no official source is usable: SENSEX, the US indices
// and company financials. The page labels everything that comes from here.
import { round } from '../../lib/pivot.js';
import { cachedDownload } from './http.js';

const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const TIMESERIES_URL = 'https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries';
const FINANCIAL_YEARS = 4;
// Yahoo refuses a full browser identifier from a client that doesn't behave like a browser, and accepts this one.
const HEADERS = { 'User-Agent': 'Mozilla/5.0' };

export const localDate = (seconds, gmtoffset) =>
  new Date((seconds + gmtoffset) * 1000).toISOString().slice(0, 10);

function listBars({ timestamp = [], indicators, meta }) {
  const quote = indicators?.quote?.[0] ?? {};
  return timestamp.map((seconds, i) => ({
    date: localDate(seconds, meta.gmtoffset),
    open: quote.open?.[i],
    high: quote.high?.[i],
    low: quote.low?.[i],
    close: quote.close?.[i],
  }));
}

// Yahoo sometimes fills a day by repeating the last close as all four prices. No real index session is flat.
const isFlat = (bar) => bar.open === bar.high && bar.high === bar.low && bar.low === bar.close;

const hasPrices = (bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) && !isFlat(bar);

function isLive(meta, date, nowSeconds) {
  const { start, end } = meta.currentTradingPeriod?.regular ?? {};
  return start <= nowSeconds && nowSeconds < end && localDate(start, meta.gmtoffset) === date;
}

// Only finished sessions are stored, with Yahoo's float noise (25696.849609375) rounded away.
export function completedSessions(chart, nowSeconds = Date.now() / 1000) {
  const decimals = chart.meta.priceHint ?? 2;
  return listBars(chart)
    .filter((bar) => hasPrices(bar) && !isLive(chart.meta, bar.date, nowSeconds))
    .map((bar) => ({
      date: bar.date,
      open: round(bar.open, decimals),
      high: round(bar.high, decimals),
      low: round(bar.low, decimals),
      close: round(bar.close, decimals),
    }));
}

// Days Yahoo lists as trading days but sends blank prices for, which is not the same as a holiday.
export function missingDays(chart, nowSeconds = Date.now() / 1000) {
  const priced = new Set(listBars(chart).filter(hasPrices).map((bar) => bar.date));
  return listBars(chart)
    .filter((bar) => !hasPrices(bar) && !priced.has(bar.date) && !isLive(chart.meta, bar.date, nowSeconds))
    .map((bar) => bar.date);
}

export async function fetchChart(symbol, fromIso) {
  const query = new URLSearchParams({
    period1: Math.floor(Date.parse(fromIso) / 1000),
    period2: Math.floor(Date.now() / 1000) + 86400,
    interval: '1d',
  });
  const today = new Date().toISOString().slice(0, 10);
  const body = await cachedDownload(
    `yahoo/charts/${today}/${symbol.replace(/[^\w-]/g, '_')}.json`,
    `${CHART_URL}/${encodeURIComponent(symbol)}?${query}`,
    { headers: HEADERS },
  );
  const chart = body && JSON.parse(body.toString('utf8')).chart?.result?.[0];
  if (!chart) throw new Error(`Yahoo has no chart for ${symbol}`);
  return chart;
}

export function parseFinancials(json) {
  const byYear = new Map();
  for (const series of json.timeseries?.result ?? []) {
    const type = series.meta?.type?.[0];
    for (const point of series[type] ?? []) {
      if (!point?.asOfDate) continue;
      if (!byYear.has(point.asOfDate)) byYear.set(point.asOfDate, { year: point.asOfDate });
      byYear.get(point.asOfDate)[type] = point.reportedValue?.raw ?? null;
    }
  }
  return [...byYear.values()]
    .sort((a, b) => a.year.localeCompare(b.year))
    .slice(-FINANCIAL_YEARS)
    .map((row) => ({
      year: row.year,
      revenue: row.annualTotalRevenue ?? null,
      profit: row.annualNetIncome ?? null,
      eps: row.annualDilutedEPS ?? null,
      equity: row.annualStockholdersEquity ?? null,
      debt: row.annualTotalDebt ?? null,
    }));
}

// Annual figures change rarely, so these are fetched once a month to go easy on Yahoo.
export const financialsPeriod = (now = new Date()) => now.toISOString().slice(0, 7);

export async function fetchFinancials(symbol) {
  const query = new URLSearchParams({
    symbol: `${symbol}.NS`,
    type: 'annualTotalRevenue,annualNetIncome,annualDilutedEPS,annualStockholdersEquity,annualTotalDebt',
    period1: 1420070400,
    period2: Math.floor(Date.now() / 1000),
  });
  const body = await cachedDownload(
    `yahoo/financials/${financialsPeriod()}/${symbol.replace(/[^\w-]/g, '_')}.json`,
    `${TIMESERIES_URL}/${encodeURIComponent(`${symbol}.NS`)}?${query}`,
    { headers: HEADERS },
  );
  return body ? parseFinancials(JSON.parse(body.toString('utf8'))) : [];
}
