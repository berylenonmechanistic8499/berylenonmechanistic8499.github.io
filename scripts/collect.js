// Gathers every instrument's prices, fundamentals and news into one dataset for the page.
import { round } from '../lib/pivot.js';
import { findDatasetProblems, separateLateReports } from './dataset-checks.js';
import { mapPool, pruneFolders, RateLimited, readCache, sleep, writeCache } from './sources/http.js';
import { fetchHeadlines, newsSearchUrl } from './sources/news.js';
import {
  collectIndexSessions,
  collectStockSessions,
  createSymbolResolver,
  detectPriceActions,
  fetchDailyBundle,
  fetchEquityList,
  fetchIndexReport,
  fetchNifty100List,
  fetchPeReport,
  fetchPriceReport,
  fetchSymbolChanges,
  parseAnnouncements,
  parseBoardMeetings,
  parseCorporateActions,
  parseMarketCaps,
  toIsoDate,
  toNumber,
} from './sources/nse.js';
import { completedSessions, fetchChart, fetchFinancials, financialsPeriod, missingDays } from './sources/yahoo.js';

const YEARS = 3;
const FILING_DAYS = 8;
const MAX_FILINGS = 5;
const DAY_MS = 86_400_000;

const NSE_INDICES = [
  { symbol: 'NIFTY 50', report: 'Nifty 50', news: '"Nifty 50"', keyword: 'nifty' },
  { symbol: 'NIFTY BANK', label: 'BANK NIFTY', report: 'Nifty Bank', news: '"Bank Nifty" OR "Nifty Bank"', keyword: 'bank' },
  { symbol: 'NIFTY FINANCIAL SERVICES', label: 'FINNIFTY', report: 'Nifty Financial Services', news: '"Nifty Financial Services" OR "FinNifty"', keyword: 'fin' },
  { symbol: 'NIFTY NEXT 50', report: 'Nifty Next 50', news: '"Nifty Next 50"', keyword: 'next 50' },
  { symbol: 'NIFTY 100', report: 'Nifty 100', news: '"Nifty 100"', keyword: 'nifty' },
  { symbol: 'NIFTY 500', report: 'Nifty 500', news: '"Nifty 500"', keyword: 'nifty' },
  { symbol: 'NIFTY MIDCAP 100', report: 'NIFTY Midcap 100', news: '"Nifty Midcap 100" OR "Nifty Midcap"', keyword: 'midcap' },
  { symbol: 'NIFTY SMALLCAP 100', report: 'NIFTY Smallcap 100', news: '"Nifty Smallcap 100" OR "Nifty Smallcap"', keyword: 'smallcap' },
  { symbol: 'NIFTY IT', report: 'Nifty IT', news: '"Nifty IT"', keyword: 'it' },
  { symbol: 'NIFTY AUTO', report: 'Nifty Auto', news: '"Nifty Auto"', keyword: 'auto' },
  { symbol: 'NIFTY PHARMA', report: 'Nifty Pharma', news: '"Nifty Pharma"', keyword: 'pharma' },
  { symbol: 'NIFTY FMCG', report: 'Nifty FMCG', news: '"Nifty FMCG"', keyword: 'fmcg' },
  { symbol: 'NIFTY METAL', report: 'Nifty Metal', news: '"Nifty Metal"', keyword: 'metal' },
  { symbol: 'NIFTY REALTY', report: 'Nifty Realty', news: '"Nifty Realty"', keyword: 'realty' },
  { symbol: 'NIFTY ENERGY', report: 'Nifty Energy', news: '"Nifty Energy"', keyword: 'energy' },
  { symbol: 'NIFTY PSU BANK', report: 'Nifty PSU Bank', news: '"Nifty PSU Bank"', keyword: 'psu' },
  { symbol: 'NIFTY PRIVATE BANK', report: 'Nifty Private Bank', news: '"Nifty Private Bank"', keyword: 'bank' },
  { symbol: 'INDIA VIX', report: 'India VIX', news: '"India VIX"', keyword: 'vix' },
];

const OTHER_INDICES = [
  { symbol: 'SENSEX', yahoo: '^BSESN', name: 'BSE SENSEX', exchange: 'BSE', currency: 'INR', news: '"Sensex"', keyword: 'sensex', region: 'IN' },
  { symbol: 'S&P 500', yahoo: '^GSPC', name: 'S&P 500', exchange: 'US', currency: 'USD', news: '"S&P 500"', keyword: 's&p', region: 'US' },
  { symbol: 'DOW JONES', label: 'DOW', yahoo: '^DJI', name: 'Dow Jones Industrial Average', exchange: 'US', currency: 'USD', news: '"Dow Jones"', keyword: 'dow', region: 'US' },
  // Nasdaq's own feed repeats the previous close as the open on about 25 of 750 days, which would skew the pivot.
  { symbol: 'NASDAQ COMPOSITE', label: 'NASDAQ', yahoo: '^IXIC', name: 'NASDAQ Composite', exchange: 'NASDAQ', currency: 'USD', news: '"Nasdaq Composite" OR "Nasdaq"', keyword: 'nasdaq', region: 'US' },
];

// Names the financial press uses more often than the registered company name.
const PRESS_NAMES = {
  SBIN: 'SBI',
  HINDUNILVR: 'HUL',
  LT: 'L&T',
  'M&M': 'M&M',
  TCS: 'TCS',
  RELIANCE: 'RIL',
  ITC: 'ITC',
  BEL: 'Bharat Electronics',
  HAL: 'HAL',
  ONGC: 'ONGC',
  NTPC: 'NTPC',
  DRREDDY: 'Dr Reddy',
  IRFC: 'IRFC',
  MOTHERSON: 'Motherson',
  LTM: 'LTIMindtree',
  TMPV: 'Tata Motors',
};

const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

function datesBetween(fromIso, toIso) {
  const dates = [];
  for (let time = Date.parse(fromIso); time <= Date.parse(toIso); time += DAY_MS) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

const toDay = (iso) => Date.parse(iso) / DAY_MS;

const isPossible = ({ open, high, low, close }) =>
  low <= high && open >= low && open <= high && close >= low && close <= high;

// A row no market could have produced is dropped rather than turned into a wrong pivot.
function keepPossible(sessions, symbol) {
  const rejected = sessions.filter((session) => !isPossible(session)).map((session) => session.date);
  if (rejected.length) log(`Rejected impossible prices for ${symbol}: ${rejected.join(', ')}`);
  return { kept: sessions.filter(isPossible), rejected };
}

function seriesFields(sessions, extraKeys = {}) {
  const fields = {
    days: sessions.map((session) => toDay(session.date)),
    o: sessions.map((session) => session.open),
    h: sessions.map((session) => session.high),
    l: sessions.map((session) => session.low),
    c: sessions.map((session) => session.close),
  };
  for (const [field, key] of Object.entries(extraKeys)) {
    fields[field] = sessions.map((session) => session[key] ?? null);
  }
  return fields;
}

const companyShortName = (name) => name.replace(/\s+(limited|ltd\.?)$/i, '').replace(/\s+\(india\)$/i, '').trim();

function stockNewsTerms(symbol, shortName) {
  const press = PRESS_NAMES[symbol];
  const firstWords = shortName.split(/\s+/).slice(0, 2).join(' ').toLowerCase();
  const query = press && press !== shortName ? `("${shortName}" OR "${press}")` : `"${shortName}"`;
  return {
    query: `${query} (share OR stock)`,
    isRelevant: (title) => {
      const lower = title.toLowerCase();
      return lower.includes(firstWords) || lower.includes(symbol.toLowerCase()) || Boolean(press && lower.includes(press.toLowerCase()));
    },
  };
}

async function collectNseReports(fromIso, toIso) {
  const dates = datesBetween(fromIso, toIso);
  log(`Reading NSE's index report for ${dates.length} calendar days…`);
  const indexReports = (await mapPool(dates, 3, 60, async (date) => ({ date, rows: await fetchIndexReport(date) }))).filter(
    (report) => report.rows?.length,
  );
  log(`${indexReports.length} trading days. Reading NSE's price report for each…`);
  const priceReports = await mapPool(indexReports, 3, 60, async ({ date }) => ({ date, rows: await fetchPriceReport(date) }));
  const { ready, late } = separateLateReports(priceReports);
  if (late.length) log(`NSE hasn't published prices for ${late.join(', ')} yet, so they wait for the next update.`);
  const readyDates = new Set(ready.map((report) => report.date));
  return { indexReports: indexReports.filter((report) => readyDates.has(report.date)), priceReports: ready };
}

async function collectExchangeNotices(tradingDays, targets) {
  const recent = tradingDays.slice(-FILING_DAYS);
  const bundles = await mapPool(recent, 2, 100, async (date) => ({ date, bundle: await fetchDailyBundle(date) }));
  const available = bundles.filter(({ bundle }) => bundle);
  if (!available.length) {
    log('No NSE daily bundle could be read, so filings and market caps stay as they were.');
    return null;
  }
  const latest = available.at(-1);
  const today = new Date().toISOString().slice(0, 10);
  return {
    filings: available.flatMap(({ date, bundle }) => parseAnnouncements(bundle.announcements, date, targets)),
    corporateActions: parseCorporateActions(latest.bundle.corporateActions, today, targets),
    boardMeetings: available.flatMap(({ bundle }) => parseBoardMeetings(bundle.boardMeetings, today, targets)),
    marketCaps: parseMarketCaps(latest.bundle.marketCaps, targets),
  };
}

async function collectFinancials(symbols) {
  const financials = new Map();
  for (const symbol of symbols) {
    try {
      financials.set(symbol, await fetchFinancials(symbol));
    } catch (error) {
      if (error instanceof RateLimited) {
        log(`Yahoo is rate-limiting, so financials stop after ${financials.size} of ${symbols.length} companies.`);
        break;
      }
      log(`Financials unavailable for ${symbol}: ${error.message}`);
    }
    await sleep(500);
  }
  return financials;
}

async function collectHeadlines(requests) {
  log(`Reading headlines for ${requests.length} instruments…`);
  const results = await mapPool(requests, 1, 700, async (request) => {
    try {
      return [request.key, await fetchHeadlines(request)];
    } catch (error) {
      log(`Keeping earlier headlines for ${request.key}: ${error.message}`);
      return [request.key, previous.get(request.key)?.news ?? []];
    }
  });
  return new Map(results);
}

const today = new Date().toISOString().slice(0, 10);
const fromIso = new Date(Date.now() - Math.round(YEARS * 365.25) * DAY_MS).toISOString().slice(0, 10);

// When a source fails, an instrument keeps what it had rather than losing it.
const previousDataset = JSON.parse(readCache('dataset.json') ?? 'null');
const previous = new Map((previousDataset?.instruments ?? []).map((item) => [item.symbol, item]));

pruneFolders('news', today);
pruneFolders('yahoo/charts', today);
pruneFolders('nse/lists', today);
pruneFolders('yahoo/financials', financialsPeriod());

const [nifty100, equityList, symbolChanges] = await Promise.all([
  fetchNifty100List(),
  fetchEquityList(),
  fetchSymbolChanges(),
]);
const listings = new Map(equityList.map((row) => [row.SYMBOL, row]));
const targets = new Set(nifty100.map((row) => row.Symbol));
if (targets.size < 90) throw new Error(`Unexpected NIFTY 100 list: ${targets.size} symbols`);

const { indexReports, priceReports } = await collectNseReports(fromIso, today);
const tradingDays = indexReports.map((report) => report.date);
const latestDay = tradingDays.at(-1);
log(`NSE data runs from ${tradingDays[0]} to ${latestDay}.`);

const stockSessions = collectStockSessions(priceReports, targets, createSymbolResolver(symbolChanges));
const notices = await collectExchangeNotices(tradingDays, targets);

const peReport = (await fetchPeReport(latestDay)) ?? [];
const peBySymbol = new Map(peReport.map((row) => [row.SYMBOL, row]));
log(`Read P/E for ${peReport.length} NSE stocks.`);

const financials = await collectFinancials([...targets]);
log(`Read financials for ${financials.size} companies.`);

const yahooCharts = new Map();
for (const index of OTHER_INDICES) {
  try {
    yahooCharts.set(index.symbol, await fetchChart(index.yahoo, fromIso));
  } catch (error) {
    log(`Keeping earlier ${index.symbol} prices: ${error.message}`);
  }
  await sleep(1000);
}

const stockNews = nifty100.map((row) => {
  const name = listings.get(row.Symbol)?.['NAME OF COMPANY'] ?? row['Company Name'];
  const shortName = companyShortName(name);
  return { key: row.Symbol, ...stockNewsTerms(row.Symbol, shortName), displayQuery: shortName };
});
const keywordRelevance = (keyword) => (title) => title.toLowerCase().includes(keyword);
const indexNews = [...NSE_INDICES, ...OTHER_INDICES].map(
  (index) => ({ key: index.symbol, query: index.news, region: index.region ?? 'IN', isRelevant: keywordRelevance(index.keyword) }),
);
const headlines = await collectHeadlines([...indexNews, ...stockNews]);

const instruments = [];

for (const index of NSE_INDICES) {
  const { kept: sessions } = keepPossible(collectIndexSessions(indexReports, index.report), index.symbol);
  if (!sessions.length) throw new Error(`NSE's report has no rows for ${index.report}`);
  const calendar = new Set(sessions.map((session) => session.date));
  instruments.push({
    symbol: index.symbol,
    label: index.label,
    name: index.symbol,
    type: 'Index',
    exchange: 'NSE',
    currency: 'INR',
    source: 'nse',
    decimals: 2,
    ...seriesFields(sessions, { pe: 'pe', pb: 'pb', dy: 'dy' }),
    gaps: tradingDays.filter((day) => day >= sessions[0].date && !calendar.has(day)),
    actions: [],
    news: headlines.get(index.symbol) ?? [],
    newsUrl: newsSearchUrl(index.news),
    officialUrl: 'https://www.niftyindices.com/reports/historical-data',
  });
}

for (const index of OTHER_INDICES) {
  const chart = yahooCharts.get(index.symbol);
  if (!chart) {
    if (!previous.has(index.symbol)) throw new Error(`No prices available for ${index.symbol}`);
    instruments.push({ ...previous.get(index.symbol), news: headlines.get(index.symbol) ?? [] });
    continue;
  }
  const { kept: sessions, rejected } = keepPossible(completedSessions(chart), index.symbol);
  instruments.push({
    symbol: index.symbol,
    label: index.label,
    name: index.name,
    type: 'Index',
    exchange: index.exchange,
    currency: index.currency,
    source: 'yahoo',
    decimals: chart.meta.priceHint ?? 2,
    ...seriesFields(sessions),
    gaps: [...missingDays(chart), ...rejected],
    actions: [],
    news: headlines.get(index.symbol) ?? [],
    newsUrl: newsSearchUrl(index.news, index.region),
  });
}

const dropped = [];
for (const row of nifty100) {
  const symbol = row.Symbol;
  const { kept: sessions } = keepPossible(stockSessions.get(symbol), symbol);
  if (!sessions.length) {
    dropped.push(symbol);
    continue;
  }
  const listing = listings.get(symbol);
  const name = listing?.['NAME OF COMPANY'] ?? row['Company Name'];
  const traded = new Set(sessions.map((session) => session.date));
  const before = previous.get(symbol);
  const pe = peBySymbol.get(symbol);
  const cap = notices?.marketCaps.get(symbol);
  const byDate = (a, b) => b.date.localeCompare(a.date);
  instruments.push({
    symbol,
    name,
    type: 'Stock',
    exchange: 'NSE',
    currency: 'INR',
    source: 'nse',
    decimals: 2,
    ...seriesFields(sessions, { vol: 'volume', del: 'delivery' }),
    gaps: tradingDays.filter((day) => day >= sessions[0].date && !traded.has(day)),
    actions: detectPriceActions(sessions),
    profile: {
      asOf: latestDay,
      industry: row.Industry,
      isin: row['ISIN Code'],
      listed: listing ? toIsoDate(listing[' DATE OF LISTING'] ?? listing['DATE OF LISTING'] ?? '') : null,
      faceValue: cap?.faceValue ?? toNumber(listing?.['FACE VALUE'] ?? ''),
      marketCap: cap?.marketCap ?? before?.profile?.marketCap ?? null,
      shares: cap?.shares ?? before?.profile?.shares ?? null,
      // A blank P/E in NSE's report means the company has none, so the old one is kept only if the report itself is missing.
      pe: peReport.length ? toNumber(pe?.['SYMBOL P/E'] ?? '') : before?.profile?.pe ?? null,
      adjustedPe: peReport.length ? toNumber(pe?.['ADJUSTED P/E'] ?? '') : before?.profile?.adjustedPe ?? null,
    },
    financials: financials.get(symbol) ?? before?.financials ?? [],
    filings: notices
      ? notices.filings
          .filter((filing) => filing.symbol === symbol)
          .sort(byDate)
          .slice(0, MAX_FILINGS)
          .map(({ date, category, text }) => ({ date, category, text }))
      : before?.filings ?? [],
    upcoming: notices
      ? [
          ...notices.boardMeetings.filter((item) => item.symbol === symbol).map(({ date, purpose }) => ({ date, kind: 'Board meeting', text: purpose })),
          ...notices.corporateActions.filter((item) => item.symbol === symbol).map(({ date, purpose }) => ({ date, kind: 'Ex-date', text: purpose })),
        ].sort((a, b) => a.date.localeCompare(b.date))
      : (before?.upcoming ?? []).filter((event) => event.date >= today),
    news: headlines.get(symbol) ?? [],
    newsUrl: newsSearchUrl(stockNews.find((item) => item.key === symbol).query),
    officialUrl: `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`,
  });
}
if (dropped.length) log(`No NSE prices found for: ${dropped.join(', ')}`);

const stocks = instruments.filter((item) => item.type === 'Stock');
const indices = instruments.filter((item) => item.type === 'Index');
const dataset = {
  builtOn: today,
  coverage: `${stocks.length === nifty100.length ? 'NIFTY 100' : `${stocks.length} NIFTY 100`} stocks and ${indices.length} indices`,
  instruments,
};
const requiredSymbols = [...NSE_INDICES, ...OTHER_INDICES].map((index) => index.symbol);
const problems = findDatasetProblems(dataset, previousDataset, requiredSymbols, today);
if (problems.length) throw new Error(`Not publishing this update: ${problems.join('; ')}`);
writeCache('dataset.json', JSON.stringify(dataset));

const last = (item) => new Date(item.days.at(-1) * DAY_MS).toISOString().slice(0, 10);
const tally = (values) => Object.fromEntries([...new Set(values)].map((value) => [value, values.filter((v) => v === value).length]));
log(dataset.coverage);
log(`Last session by instrument: ${JSON.stringify(tally(instruments.map(last)))}`);
log(`Stocks with gaps inside their history: ${stocks.filter((s) => s.gaps.length).map((s) => `${s.symbol}(${s.gaps.length})`).join(' ') || 'none'}`);
log(`Corporate actions found (${stocks.flatMap((s) => s.actions).length}): ${stocks.flatMap((s) => s.actions.map((a) => `${s.symbol} ${a.date} x${round(a.factor, 3)}`)).join('; ') || 'none'}`);
log(`Headlines: ${instruments.filter((i) => i.news.length).length} of ${instruments.length} have some, ${instruments.reduce((sum, i) => sum + i.news.length, 0)} in total`);
log(`Filings: ${stocks.reduce((sum, s) => sum + s.filings.length, 0)}, upcoming events: ${stocks.reduce((sum, s) => sum + s.upcoming.length, 0)}`);
log(`Financials: ${stocks.filter((s) => s.financials.length).length} of ${stocks.length}. P/E: ${stocks.filter((s) => s.profile.pe).length}. Market cap: ${stocks.filter((s) => s.profile.marketCap).length}.`);
log('Done.');
