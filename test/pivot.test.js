import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket } from '../lib/market.js';
import { findDatasetProblems, separateLateReports } from '../scripts/dataset-checks.js';
import { pivotPoint } from '../lib/pivot.js';
import { decodeEntities, parseHeadlines } from '../scripts/sources/news.js';
import {
  collectIndexSessions,
  collectStockSessions,
  createSymbolResolver,
  detectPriceActions,
  parseAnnouncements,
  parseBoardMeetings,
  parseCorporateActions,
  parseCsv,
  parseMarketCaps,
  reportsOnlyThisDate,
  toIsoDate,
  toNumber,
} from '../scripts/sources/nse.js';
import { completedSessions, missingDays, parseFinancials } from '../scripts/sources/yahoo.js';

const seconds = (iso) => Date.parse(iso) / 1000;
const day = (iso) => Date.parse(iso) / 86_400_000;

test('pivot is (open + high + close) / 3 and ignores the low', () => {
  assert.equal(pivotPoint({ open: 10, high: 20, low: 1, close: 30 }), 20);
  assert.equal(pivotPoint({ open: 10, high: 20, low: 9999, close: 30 }), 20);
});

/* NSE reports */

test('reads NSE dates in all the forms its reports use', () => {
  assert.equal(toIsoDate('04-Nov-2026'), '2026-11-04');
  assert.equal(toIsoDate('05-JAN-2026'), '2026-01-05');
  assert.equal(toIsoDate('04-11-2026'), '2026-11-04');
  assert.equal(toIsoDate('04 NOV 2026'), '2026-11-04');
  assert.equal(toIsoDate('-'), null);
});

test('reads CSV with quoted commas and padded cells', () => {
  const rows = parseCsv('SYMBOL, NAME\nABC, "Alpha, Beta Ltd"\n\n');
  assert.deepEqual(rows, [{ SYMBOL: 'ABC', NAME: 'Alpha, Beta Ltd' }]);
});

test('treats a dash or blank as no number', () => {
  assert.equal(toNumber('-'), null);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('.63'), 0.63);
});

test('rejects a price report whose rows belong to another day', () => {
  // NSE answers a holiday's URL with another day's prices.
  const header = 'SYMBOL, SERIES, DATE1, PREV_CLOSE\n';
  assert.equal(reportsOnlyThisDate(`${header}ABC, EQ, 04-Nov-2025, 10\n`, '2025-11-05'), false);
  assert.equal(reportsOnlyThisDate(`${header}ABC, EQ, 05-Nov-2025, 10\n`, '2025-11-05'), true);
  assert.equal(reportsOnlyThisDate('<html>', '2025-11-05'), false);
});

const CHANGES = [
  { 'OLD SYMBOL': 'ZOMATO', 'NEW SYMBOL': 'ETERNAL', 'EFFECTIVE DATE': '09-APR-2025' },
  { 'OLD SYMBOL': 'AAA', 'NEW SYMBOL': 'BBB', 'EFFECTIVE DATE': '01-JAN-2024' },
  { 'OLD SYMBOL': 'BBB', 'NEW SYMBOL': 'CCC', 'EFFECTIVE DATE': '01-JAN-2025' },
];

test('follows a renamed ticker only for dates before the change', () => {
  const resolve = createSymbolResolver(CHANGES);
  assert.equal(resolve('ZOMATO', '2025-04-08'), 'ETERNAL');
  assert.equal(resolve('ZOMATO', '2025-04-09'), 'ZOMATO');
  assert.equal(resolve('AAA', '2023-06-01'), 'CCC');
  assert.equal(resolve('RELIANCE', '2023-06-01'), 'RELIANCE');
});

const priceRow = (symbol, series, close) => ({
  SYMBOL: symbol,
  SERIES: series,
  OPEN_PRICE: '100',
  HIGH_PRICE: '110',
  LOW_PRICE: '90',
  CLOSE_PRICE: String(close),
  TTL_TRD_QNTY: '500',
  DELIV_PER: '-',
});

test('joins a renamed stock into one history, preferring the EQ series', () => {
  const sessions = collectStockSessions(
    [
      { date: '2025-04-08', rows: [priceRow('ZOMATO', 'EQ', 101), priceRow('OTHER', 'EQ', 5)] },
      { date: '2025-04-09', rows: [priceRow('ETERNAL', 'BE', 999), priceRow('ETERNAL', 'EQ', 102), priceRow('ETERNAL', 'N1', 1)] },
    ],
    new Set(['ETERNAL']),
    createSymbolResolver(CHANGES),
  );
  assert.deepEqual(sessions.get('ETERNAL').map((s) => s.close), [101, 102]);
  assert.equal(sessions.get('ETERNAL')[0].delivery, null);
});

test('skips a price row with a missing price', () => {
  const sessions = collectStockSessions(
    [{ date: '2025-01-01', rows: [{ ...priceRow('ABC', 'EQ', 1), HIGH_PRICE: '-' }] }],
    new Set(['ABC']),
    (symbol) => symbol,
  );
  assert.deepEqual(sessions.get('ABC'), []);
});

test('finds corporate actions from overnight falls, using a clean ratio where one fits', () => {
  const actionsFor = (close, open) => detectPriceActions([{ date: '2024-10-25', close }, { date: '2024-10-28', open }]);
  // Real cases from NSE's reports.
  assert.deepEqual(actionsFor(2655.7, 1337), [{ date: '2024-10-28', factor: 0.5 }]); // Reliance 1:1 bonus
  assert.deepEqual(actionsFor(9331, 956), [{ date: '2024-10-28', factor: 0.1 }]); // Bajaj Finance split and bonus
  assert.deepEqual(actionsFor(709.4, 148.2), [{ date: '2024-10-28', factor: 0.2 }]); // Adani Power 4:1 split
  assert.equal(actionsFor(4257.6, 2830)[0].factor, Number((2 / 3).toFixed(6))); // Trent 1:2 bonus
  assert.equal(actionsFor(773.6, 289.5)[0].factor, Number((289.5 / 773.6).toFixed(6))); // Vedanta demerger keeps its own gap
  // Real market falls aren't corporate actions.
  assert.deepEqual(actionsFor(871.55, 697.25), []); // Adani Energy, 21 Nov 2024
  assert.deepEqual(actionsFor(3210.35, 2728.45), []); // BSE, 29 Apr 2024
  assert.deepEqual(actionsFor(755.8, 870), []);
});

test('reads an index under any capitalisation, with its valuation ratios', () => {
  const report = {
    date: '2026-11-04',
    rows: [
      {
        'Index Name': 'NIFTY Midcap 100',
        'Open Index Value': '10',
        'High Index Value': '12',
        'Low Index Value': '9',
        'Closing Index Value': '11',
        'P/E': '20.5',
        'P/B': '-',
        'Div Yield': '1.1',
      },
    ],
  };
  const [session] = collectIndexSessions([report], 'Nifty Midcap 100');
  assert.equal(session.close, 11);
  assert.equal(session.pe, 20.5);
  assert.equal(session.pb, null);
  assert.deepEqual(collectIndexSessions([{ ...report, rows: [{ ...report.rows[0], 'Open Index Value': '-' }] }], 'NIFTY Midcap 100'), []);
});

test('reads filings, skipping routine notices and other companies', () => {
  const text = [
    'COMPANY NAME    SYMBOL    : ANNOUNCEMENTS',
    'Tata Consultancy Services Limited TCS : Copy of Newspaper Publication TCS : Tata Consultancy Services Limited has informed the Exchange about Copy of Newspaper Publication',
    "Tata Consultancy Services Limited TCS : Updates TCS : Tata Consultancy Services Limited has informed the Exchange regarding 'Press Release'.",
    'Kuantum Papers Limited KUANTUM : Updates KUANTUM : Kuantum Papers Limited has informed the Exchange.',
  ].join('\n');
  assert.deepEqual(parseAnnouncements(text, '2026-11-04', new Set(['TCS'])), [
    { symbol: 'TCS', date: '2026-11-04', category: 'Updates', text: 'Press Release' },
  ]);
});

test('drops filing text that only repeats the category', () => {
  const line = 'Reliance Industries Limited RELIANCE : Investor Presentation RELIANCE : Reliance Industries Limited has informed the Exchange about Investor Presentation';
  assert.equal(parseAnnouncements(line, '2026-11-02', new Set(['RELIANCE']))[0].text, '');
});

test('reads only upcoming board meetings and corporate actions', () => {
  const meetings = 'COMPANY NAME    SYMBOL     : BM DATE    : BM PURPOSE\nCantabil Retail India Limited CANTABIL : 12-NOV-2026 : Financial Results CANTABIL : 13-Nov-2026 :  Rescheduled\nOld Co Limited OLD : 01-NOV-2026 : Dividend';
  assert.deepEqual(parseBoardMeetings(meetings, '2026-11-05', new Set(['CANTABIL', 'OLD'])), [
    { symbol: 'CANTABIL', date: '2026-11-12', purpose: 'Financial Results' },
  ]);
  const actions = 'SERIES,SYMBOL,SECURITY,RECORD_DT,BC_STRT_DT,BC_END_DT,EX_DT,ND_STRT_DT,ND_END_DT,PURPOSE\nEQ,POWERGRID,Power Grid,2026-11-06,,,2026-11-06,,,INTERIM DIVIDEND - RS 3 PER SHARE\nN1,POWERGRID,Bond,2026-11-06,,,2026-11-06,,,INTEREST PAYMENT\nEQ,POWERGRID,Power Grid,2026-01-01,,,2026-01-01,,,OLD';
  assert.deepEqual(parseCorporateActions(actions, '2026-11-05', new Set(['POWERGRID'])), [
    { symbol: 'POWERGRID', date: '2026-11-06', purpose: 'INTERIM DIVIDEND - RS 3 PER SHARE' },
  ]);
});

test('reads market cap from the padded EQ row', () => {
  const text = 'Trade Date,Symbol,Series,Security Name,Category,Last Trade Date,Face Value(Rs.),Issue Size,Close Price/Paid up value(Rs.),Market Cap(Rs.)              \n04 NOV 2026,RELIANCE,EQ,RELIANCE INDUSTRIES LTD  ,Listed    ,04 NOV 2026,               10.00,       13532538722,           1311.00, 17741158264542.00  ';
  assert.deepEqual(parseMarketCaps(text, new Set(['RELIANCE'])).get('RELIANCE'), {
    marketCap: 17741158264542,
    shares: 13532538722,
    faceValue: 10,
  });
});

/* Yahoo */

function yahooChart({ bars, gmtoffset = 19800, regular, priceHint = 2 }) {
  return {
    meta: { priceHint, gmtoffset, currentTradingPeriod: regular && { regular } },
    timestamp: bars.map((bar) => seconds(bar.at)),
    indicators: {
      quote: [
        {
          open: bars.map((bar) => (bar.blank ? null : bar.open ?? 100)),
          high: bars.map((bar) => (bar.blank ? null : bar.high ?? 110)),
          low: bars.map((bar) => (bar.blank ? null : bar.low ?? 90)),
          close: bars.map((bar) => (bar.blank ? null : bar.close ?? 105)),
        },
      ],
    },
  };
}

const LATER = seconds('2026-12-01T00:00:00Z');

test('cleans float noise out of Yahoo prices', () => {
  const chart = yahooChart({ bars: [{ at: '2025-11-03T03:45:00Z', open: 25696.849609375, high: 25803.099609375, low: 25645.5, close: 25763.349609375 }] });
  assert.deepEqual(completedSessions(chart, LATER), [{ date: '2025-11-03', open: 25696.85, high: 25803.1, low: 25645.5, close: 25763.35 }]);
});

test('uses the exchange’s local date, not the UTC date', () => {
  // Sydney opens at 10:00 AEDT, which is 23:00 UTC on the previous day.
  const chart = yahooChart({ bars: [{ at: '2025-11-02T23:00:00Z' }], gmtoffset: 39600 });
  assert.equal(completedSessions(chart, LATER)[0].date, '2025-11-03');
});

test('leaves an unfinished session out of stored prices', () => {
  const regular = { start: seconds('2026-11-05T03:45:00Z'), end: seconds('2026-11-05T10:00:00Z') };
  const chart = yahooChart({ bars: [{ at: '2026-11-04T03:45:00Z' }, { at: '2026-11-05T03:45:00Z' }], regular });
  const dates = (now) => completedSessions(chart, seconds(now)).map((session) => session.date);
  assert.deepEqual(dates('2026-11-05T06:36:00Z'), ['2026-11-04']);
  assert.deepEqual(dates('2026-11-05T10:00:00Z'), ['2026-11-04', '2026-11-05']);
});

test('treats a flat bar as missing, because it repeats the last close', () => {
  const chart = yahooChart({ bars: [{ at: '2025-03-17T03:45:00Z' }, { at: '2025-03-18T03:45:00Z', open: 1238.85, high: 1238.85, low: 1238.85, close: 1238.85 }] });
  assert.deepEqual(completedSessions(chart, LATER).map((session) => session.date), ['2025-03-17']);
  assert.deepEqual(missingDays(chart, LATER), ['2025-03-18']);
});

test('reports a blank bar as missing, unless the day has prices or is still trading', () => {
  const regular = { start: seconds('2026-11-05T03:45:00Z'), end: seconds('2026-11-05T10:00:00Z') };
  const chart = yahooChart({
    bars: [
      { at: '2026-11-03T03:45:00Z', blank: true },
      { at: '2026-11-04T03:45:00Z', blank: true },
      { at: '2026-11-04T09:00:00Z' },
      { at: '2026-11-05T03:45:00Z', blank: true },
    ],
    regular,
  });
  assert.deepEqual(missingDays(chart, seconds('2026-11-05T06:36:00Z')), ['2026-11-03']);
});

test('reads annual financials into yearly rows, newest years kept', () => {
  const point = (asOfDate, raw) => ({ asOfDate, reportedValue: { raw } });
  const rows = parseFinancials({
    timeseries: {
      result: [
        { meta: { type: ['annualTotalRevenue'] }, annualTotalRevenue: [null, point('2021-03-31', 1), point('2022-03-31', 2), point('2023-03-31', 3), point('2024-03-31', 4), point('2025-03-31', 5)] },
        { meta: { type: ['annualNetIncome'] }, annualNetIncome: [point('2025-03-31', 50)] },
      ],
    },
  });
  assert.deepEqual(rows.map((row) => row.year), ['2022-03-31', '2023-03-31', '2024-03-31', '2025-03-31']);
  assert.equal(rows.at(-1).profit, 50);
  assert.equal(rows[0].profit, null);
});

/* Guards on automatic updates */

const report = (date, ready = true) => ({ date, rows: ready ? [] : null });

test('lets the newest days wait when NSE hasn’t published them yet', () => {
  const reports = ['01', '02', '03', '04', '05'].map((d, i) => report(`2026-11-${d}`, i < 4));
  const { ready, late } = separateLateReports(reports);
  assert.equal(ready.length, 4);
  assert.deepEqual(late, ['2026-11-05']);
  assert.deepEqual(separateLateReports(reports.slice(0, 4)).late, []);
});

test('stops the update when a report is missing further back', () => {
  const old = ['01', '02', '03', '04', '05', '06'].map((d, i) => report(`2026-11-${d}`, i !== 1));
  assert.throws(() => separateLateReports(old), /2026-11-02/);
  const inside = ['01', '02', '03', '04', '05', '06'].map((d, i) => report(`2026-11-${d}`, i !== 4));
  assert.throws(() => separateLateReports(inside), /2026-11-05/);
});

function healthyDataset(latest = '2026-11-04') {
  const instrument = (symbol, type) => ({ symbol, type, source: 'nse', days: [day(latest)], o: [1], h: [1], l: [1], c: [1] });
  return {
    instruments: [
      instrument('NIFTY 50', 'Index'),
      ...Array.from({ length: 95 }, (_, i) => instrument(`S${i}`, 'Stock')),
    ],
  };
}

test('accepts a healthy update', () => {
  assert.deepEqual(findDatasetProblems(healthyDataset(), healthyDataset('2026-11-03'), ['NIFTY 50'], '2026-11-05'), []);
});

test('refuses an update that would damage the page', () => {
  const problemsOf = (dataset, previous = null, required = ['NIFTY 50']) => findDatasetProblems(dataset, previous, required, '2026-11-05');
  const fewer = healthyDataset();
  fewer.instruments = fewer.instruments.slice(0, 50);
  assert.match(problemsOf(fewer)[0], /only 49 stocks/);
  assert.match(problemsOf(healthyDataset(), null, ['SENSEX'])[0], /SENSEX is missing/);
  assert.match(problemsOf(healthyDataset('2026-11-03'), healthyDataset('2026-11-04'))[0], /went backwards/);
  assert.match(problemsOf(healthyDataset('2026-10-01'))[0], /newest NSE data/);
  const broken = healthyDataset();
  broken.instruments[0].c = [];
  assert.match(problemsOf(broken)[0], /incomplete prices/);
});

/* News */

const NOW = Date.parse('2026-11-05T12:00:00Z');
const item = (title, publisher, { link = 'https://news.google.com/rss/articles/x', date = 'Wed, 04 Nov 2026 08:00:00 GMT' } = {}) =>
  `<item><title>${title} - ${publisher}</title><link>${link}</link><pubDate>${date}</pubDate><source url="https://x">${publisher}</source></item>`;

test('keeps headlines only from trusted publishers, and strips the publisher from the title', () => {
  const xml = item('Reliance jumps &amp; rises', 'Reuters') + item('Reliance moon soon', 'Some Blog');
  assert.deepEqual(parseHeadlines(xml, { now: NOW }), [
    { title: 'Reliance jumps & rises', publisher: 'Reuters', url: 'https://news.google.com/rss/articles/x', date: '2026-11-04' },
  ]);
});

test('refuses unsafe links, old stories, duplicates and off-topic titles', () => {
  const xml = [
    item('Unsafe', 'Reuters', { link: 'javascript:alert(1)' }),
    item('Elsewhere', 'Reuters', { link: 'https://example.com/a' }),
    item('Old story', 'Reuters', { date: 'Wed, 01 Jan 2025 08:00:00 GMT' }),
    item('Same headline here', 'Reuters'),
    item('Same headline here!', 'Mint'),
    item('Off topic', 'Reuters'),
  ].join('');
  const titles = parseHeadlines(xml, { now: NOW, isRelevant: (title) => !title.startsWith('Off') }).map((story) => story.title);
  assert.deepEqual(titles, ['Same headline here']);
});

test('decodes numeric and named entities once', () => {
  assert.equal(decodeEntities('A &amp; B &#39;C&#x27; &amp;amp;'), "A & B 'C' &amp;");
});

/* The page's market logic */

function stock(overrides = {}) {
  return {
    symbol: 'ABC',
    name: 'Alpha Beta Limited',
    type: 'Stock',
    exchange: 'NSE',
    currency: 'INR',
    source: 'nse',
    decimals: 2,
    days: ['2024-10-24', '2024-10-25', '2024-10-28', '2024-10-29', '2024-10-31'].map(day),
    o: [2500, 2600, 1300, 1310, 1320],
    h: [2600, 2700, 1350, 1340, 1330],
    l: [2400, 2500, 1290, 1300, 1310],
    c: [2550, 2640, 1330, 1320, 1325],
    vol: [10, 20, 30, 40, 50],
    del: [50, 51, 52, 53, null],
    gaps: ['2024-10-30'],
    actions: [{ date: '2024-10-28', factor: 0.5 }],
    news: [],
    ...overrides,
  };
}

const marketOf = (...instruments) => createMarket({ builtOn: '2024-11-01', coverage: 'test', instruments });

test('gives the pivot and the actual traded prices for a session', () => {
  const { session } = marketOf(stock()).lookup('ABC', '2024-10-24');
  assert.equal(session.pivot, 2550);
  assert.equal(session.open, 2500);
  assert.equal(session.delivery, 50);
  assert.equal(session.closeVsPivot, 0);
});

test('states no change for a corporate-action day or the first day, and a normal one otherwise', () => {
  const market = marketOf(stock());
  assert.equal(market.lookup('ABC', '2024-10-28').session.change, null);
  assert.equal(market.lookup('ABC', '2024-10-24').session.change, null);
  assert.equal(market.lookup('ABC', '2024-10-29').session.change, -10);
  assert.equal(market.lookup('ABC', '2024-10-29').session.changePercent, -0.75);
});

test('draws the chart on the selected session’s price basis, keeping actual prices for reading', () => {
  const after = marketOf(stock()).lookup('ABC', '2024-10-29').chart;
  assert.equal(after.bars[0].chartClose, 1275);
  assert.equal(after.bars[0].close, 2550);
  assert.equal(after.bars[0].pivot, 2550);
  assert.equal(after.bars[after.selectedIndex].chartClose, 1320);
  assert.deepEqual(after.rescaledFor, ['2024-10-28']);

  const before = marketOf(stock()).lookup('ABC', '2024-10-24').chart;
  assert.equal(before.bars[0].chartClose, 2550);
  assert.equal(before.bars[3].chartClose, 2640);
});

test('flags only corporate actions after the selected session', () => {
  const market = marketOf(stock());
  assert.deepEqual(market.lookup('ABC', '2024-10-25').laterActions, [{ date: '2024-10-28', factor: 0.5 }]);
  assert.deepEqual(market.lookup('ABC', '2024-10-28').laterActions, []);
});

test('works out the range on one price basis, and says when it covers under a year', () => {
  const { range } = marketOf(stock()).lookup('ABC', '2024-10-29');
  assert.equal(range.high, 1350);
  assert.equal(range.highDate, '2024-10-25');
  assert.equal(range.low, 1200);
  assert.equal(range.lowDate, '2024-10-24');
  assert.equal(range.coversYear, false);
  assert.equal(range.yearReturn, null);
  assert.equal(range.from, '2024-10-24');
});

test('gives a one-year return when a full year of history exists', () => {
  const days = [day('2023-10-30'), day('2024-10-29')];
  const item2 = stock({ days, o: [100, 200], h: [100, 200], l: [100, 200], c: [100, 150], gaps: [], actions: [], vol: [1, 1], del: [1, 1] });
  const { range } = marketOf(item2).lookup('ABC', '2024-10-29');
  assert.equal(range.coversYear, true);
  assert.equal(range.yearReturn, 50);
});

test('tells a holiday from a data gap, an unlisted date and the end of the data', () => {
  const market = marketOf(stock());
  const reason = (date) => market.lookup('ABC', date).reason;
  assert.equal(reason('2024-10-26'), 'closed');
  assert.equal(reason('2024-10-30'), 'missing');
  assert.equal(reason('2024-10-01'), 'before');
  assert.equal(reason('2024-11-01'), 'ended');
});

test('offers the neighbouring sessions when a day has none', () => {
  const data = marketOf(stock()).lookup('ABC', '2024-10-26');
  assert.equal(data.session, null);
  assert.equal(data.previousSession, '2024-10-25');
  assert.equal(data.nextSession, '2024-10-28');
});

test('search finds names, symbols and button labels, ranking button names first', () => {
  const market = marketOf(
    stock({ symbol: 'HDFCBANK', name: 'HDFC Bank Limited' }),
    stock({ symbol: 'SENSEX', name: 'S&P BSE SENSEX' }),
    stock({ symbol: 'S&P 500', name: 'S&P 500', label: 'S&P 500' }),
    stock({ symbol: 'NIFTY BANK', name: 'NIFTY BANK', label: 'BANK NIFTY' }),
  );
  const symbols = (query) => market.search(query).map((option) => option.symbol);
  assert.deepEqual(symbols('hdfc bank'), ['HDFCBANK']);
  assert.deepEqual(symbols('bank hdfc'), ['HDFCBANK']);
  assert.equal(symbols('s&p')[0], 'S&P 500');
  assert.equal(symbols('bank nifty')[0], 'NIFTY BANK');
  assert.deepEqual(symbols('zzqqxx'), []);
  assert.deepEqual(symbols('   '), []);
});
