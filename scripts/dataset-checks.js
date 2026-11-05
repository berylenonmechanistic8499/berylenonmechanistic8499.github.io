// Guards that keep a failed update from reaching the live page.
const DAY_MS = 86_400_000;
const LATE_REPORT_DAYS = 3;
const MAX_DATA_AGE_DAYS = 10;
const MIN_STOCKS = 90;

const isoDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

// NSE can publish a day's index report before its price report. Such a day simply waits for the next
// run, but a gap further back means something is wrong, and the update should stop.
export function separateLateReports(reports) {
  const firstLateIndex = reports.length - LATE_REPORT_DAYS;
  const old = reports.filter((report, index) => !report.rows && index < firstLateIndex).map((report) => report.date);
  if (old.length) throw new Error(`NSE has no price report for trading days: ${old.join(', ')}`);
  let ready = reports.length;
  while (ready > 0 && !reports[ready - 1].rows) ready--;
  const missingInside = reports.slice(0, ready).filter((report) => !report.rows).map((report) => report.date);
  if (missingInside.length) throw new Error(`NSE has no price report for trading days: ${missingInside.join(', ')}`);
  return { ready: reports.slice(0, ready), late: reports.slice(ready).map((report) => report.date) };
}

const latestNseDay = (dataset) =>
  Math.max(...dataset.instruments.filter((item) => item.source === 'nse').map((item) => item.days.at(-1)));

export function findDatasetProblems(dataset, previous, requiredSymbols, today) {
  const problems = [];
  const symbols = new Set(dataset.instruments.map((item) => item.symbol));
  const stocks = dataset.instruments.filter((item) => item.type === 'Stock');

  if (stocks.length < MIN_STOCKS) problems.push(`only ${stocks.length} stocks`);
  for (const symbol of requiredSymbols) {
    if (!symbols.has(symbol)) problems.push(`${symbol} is missing`);
  }
  for (const item of dataset.instruments) {
    const lengths = [item.days, item.o, item.h, item.l, item.c].map((series) => series.length);
    if (!lengths[0] || new Set(lengths).size > 1) problems.push(`${item.symbol} has incomplete prices`);
  }

  const latest = latestNseDay(dataset);
  if (previous && latest < latestNseDay(previous)) {
    problems.push(`NSE data went backwards, from ${isoDay(latestNseDay(previous))} to ${isoDay(latest)}`);
  }
  if (Date.parse(today) / DAY_MS - latest > MAX_DATA_AGE_DAYS) {
    problems.push(`the newest NSE data is from ${isoDay(latest)}`);
  }
  return problems;
}
