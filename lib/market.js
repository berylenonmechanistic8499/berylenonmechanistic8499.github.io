// Answers the page's questions from the dataset built into it.
import { pivotPoint, round } from './pivot.js';

const DAY_MS = 86_400_000;
const RANGE_DAYS = 365;
const RANGE_GRACE_DAYS = 7;
const WINDOW_BEFORE = 45;
const WINDOW_AFTER = 15;
const MAX_RESULTS = 10;

export const isoDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const toDay = (iso) => Date.parse(iso) / DAY_MS;

function actualBar(item, i) {
  const { o, h, l, c, decimals } = item;
  const bar = { date: isoDay(item.days[i]), open: o[i], high: h[i], low: l[i], close: c[i] };
  return { ...bar, pivot: round(pivotPoint(bar), decimals) };
}

// What to multiply a price from session `from` by, to compare it with prices at session `to`.
// A corporate action (a split, say) shifts the basis of every price either side of it.
function basisFactor(item, from, to) {
  if (from === to) return 1;
  const startDay = item.days[Math.min(from, to)];
  const endDay = item.days[Math.max(from, to)];
  const combined = item.actions
    .filter(({ date }) => toDay(date) > startDay && toDay(date) <= endDay)
    .reduce((product, { factor }) => product * factor, 1);
  return from < to ? combined : 1 / combined;
}

function describeSession(item, i) {
  const { decimals } = item;
  const bar = actualBar(item, i);
  // NSE publishes no adjusted previous close, so a day's change can't be stated exactly across a corporate action.
  const hasAction = item.actions.some(({ date }) => toDay(date) === item.days[i]);
  const previous = i > 0 && !hasAction ? item.c[i - 1] : null;
  const closeVsPivot = round(bar.close - bar.pivot, decimals);
  return {
    ...bar,
    change: previous === null ? null : round(bar.close - previous, decimals),
    changePercent: previous === null ? null : round(((bar.close - previous) / previous) * 100, 2),
    closeVsPivot,
    closeVsPivotPercent: round((closeVsPivot / bar.pivot) * 100, 2),
    volume: item.vol?.[i] ?? null,
    delivery: item.del?.[i] ?? null,
    pe: item.pe?.[i] ?? null,
    pb: item.pb?.[i] ?? null,
    dividendYield: item.dy?.[i] ?? null,
  };
}

function yearRange(item, i) {
  const { decimals } = item;
  const startDay = item.days[i] - RANGE_DAYS;
  let first = i;
  while (first > 0 && item.days[first - 1] >= startDay) first--;

  let high = -Infinity;
  let low = Infinity;
  let highDate;
  let lowDate;
  for (let j = first; j <= i; j++) {
    const factor = basisFactor(item, j, i);
    if (item.h[j] * factor > high) {
      high = item.h[j] * factor;
      highDate = isoDay(item.days[j]);
    }
    if (item.l[j] * factor < low) {
      low = item.l[j] * factor;
      lowDate = isoDay(item.days[j]);
    }
  }
  const close = item.c[i];
  const coversYear = item.days[first] - startDay <= RANGE_GRACE_DAYS;
  const openingClose = item.c[first] * basisFactor(item, first, i);
  return {
    high: round(high, decimals),
    low: round(low, decimals),
    highDate,
    lowDate,
    from: isoDay(item.days[first]),
    coversYear,
    position: high === low ? 0.5 : Math.min(1, Math.max(0, (close - low) / (high - low))),
    yearReturn: coversYear ? round(((close - openingClose) / openingClose) * 100, 2) : null,
  };
}

function chartWindow(item, i) {
  const { decimals } = item;
  const start = Math.max(0, i - WINDOW_BEFORE);
  const end = Math.min(item.days.length - 1, i + WINDOW_AFTER);
  const bars = [];
  for (let j = start; j <= end; j++) {
    const factor = basisFactor(item, j, i);
    const scale = (price) => round(price * factor, decimals);
    bars.push({
      ...actualBar(item, j),
      chartOpen: scale(item.o[j]),
      chartHigh: scale(item.h[j]),
      chartLow: scale(item.l[j]),
      chartClose: scale(item.c[j]),
    });
  }
  const rescaledFor = item.actions
    .map(({ date }) => date)
    .filter((date) => toDay(date) > item.days[start] && toDay(date) <= item.days[end]);
  return { bars, selectedIndex: i - start, rescaledFor };
}

function noSessionReason(item, date) {
  if (date > isoDay(item.days.at(-1))) return 'ended';
  if (item.gaps.includes(date)) return 'missing';
  if (date < isoDay(item.days[0])) return 'before';
  return 'closed';
}

export function createMarket({ builtOn, coverage, instruments }) {
  const bySymbol = new Map(instruments.map((item) => [item.symbol, item]));

  return {
    builtOn,
    coverage,
    minDate: isoDay(Math.min(...instruments.map((item) => item.days[0]))),
    maxDate: isoDay(Math.max(...instruments.map((item) => item.days.at(-1)))),

    has: (symbol) => bySymbol.has(symbol),

    lookup(symbol, date) {
      const item = bySymbol.get(symbol);
      const day = toDay(date);
      const i = item.days.indexOf(day);
      const previousIndex = item.days.findLastIndex((candidate) => candidate < day);
      const nextIndex = item.days.findIndex((candidate) => candidate > day);
      const base = {
        instrument: item,
        date,
        previousSession: previousIndex < 0 ? null : isoDay(item.days[previousIndex]),
        nextSession: nextIndex < 0 ? null : isoDay(item.days[nextIndex]),
      };
      if (i < 0) return { ...base, session: null, reason: noSessionReason(item, date) };
      return {
        ...base,
        session: describeSession(item, i),
        range: yearRange(item, i),
        chart: chartWindow(item, i),
        laterActions: item.actions.filter((action) => toDay(action.date) > day),
      };
    },

    search(query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return [];
      const [first] = terms;
      const rank = ({ symbol, name, label }) => {
        if (symbol.toLowerCase().startsWith(first) || label?.toLowerCase().startsWith(first)) return 0;
        return name.toLowerCase().startsWith(first) ? 1 : 2;
      };
      return instruments
        .filter(({ symbol, name, label }) => {
          const haystack = `${symbol} ${name} ${label ?? ''}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        })
        .sort((a, b) => rank(a) - rank(b))
        .slice(0, MAX_RESULTS)
        .map(({ symbol, name, label, exchange, type }) => ({ symbol, name, label, exchange, type }));
    },
  };
}
