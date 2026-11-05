// IPO records from NSE, turned into the facts the page shows.
import { round } from '../../lib/pivot.js';
import { cachedDownload, download } from './http.js';
import { toIsoDate, toNumber } from './nse.js';

const API = 'https://www.nseindia.com/api';
const HEADERS = { Accept: 'application/json' };
const EQUITY_SERIES = new Set(['EQ', 'BE', 'BZ', 'SM', 'ST', 'SME']);
const SME_TYPES = new Set(['SM', 'ST', 'SME']);
const MAX_FACT_LENGTH = 260;
// NSE records a cancelled issue by adding a note to the company's name.
const CANCELLED_NOTE = /[\s-–]*issue\s+(withdrawn|postponed)\s*$/i;
const OTHER_NOTE = /[\s-–]*special\s+withdrawal\s+option\s*$/i;

const FACTS = [
  ['Issue Type', 'type'],
  ['Issue Size', 'size'],
  ['Price Range', 'band'],
  ['Face Value', 'faceValue'],
  ['Bid Lot', 'lot'],
  ['Minimum Order Quantity', 'minQuantity'],
  ['Maximum Subscription Amount for Retail', 'retailLimit'],
  ['Cut-off time for UPI', 'upiCutoff'],
  ['IPO Market Timings', 'timings'],
  ['Book Running Lead Managers', 'managers'],
  ['Name of the Registrar', 'registrar'],
  ['Sponsor Bank', 'sponsorBank'],
];

const DOCUMENTS = [
  ['Red Herring Prospectus', 'Red herring prospectus'],
  ['Ratios / Basis of Issue Price', 'Basis of issue price'],
  ['Anchor Allocation Report', 'Anchor allocation'],
  ['Sample Application Forms', 'Application forms'],
];

const cleanText = (value) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();

function shorten(text) {
  if (text.length <= MAX_FACT_LENGTH) return text;
  return `${text.slice(0, MAX_FACT_LENGTH).replace(/\s+\S*$/, '')}…`;
}

// "Rs. 78/- to Rs. 82/- per Equity Share" or "Rs.150"
export function parsePriceBand(text) {
  const numbers = [...String(text ?? '').matchAll(/\d[\d,]*(?:\.\d+)?/g)].map(([value]) => Number(value.replaceAll(',', '')));
  if (!numbers.length) return { low: null, high: null };
  return { low: numbers[0], high: numbers[1] ?? numbers[0] };
}

export function splitIssueName(rawName) {
  const name = cleanText(rawName);
  const cancelled = name.match(CANCELLED_NOTE);
  return {
    name: name.replace(CANCELLED_NOTE, '').replace(OTHER_NOTE, ''),
    cancelled: cancelled ? cancelled[1].toLowerCase() : null,
  };
}

const isEquityIssue = (row) => EQUITY_SERIES.has(String(row.securityType ?? row.series ?? '').trim());

export function parsePastIssues(rows) {
  return rows.filter(isEquityIssue).map((row) => {
    const band = parsePriceBand(row.priceRange);
    return {
      symbol: String(row.symbol).trim(),
      ...splitIssueName(row.companyName ?? row.company),
      board: SME_TYPES.has(String(row.securityType).trim()) ? 'SME' : 'Main board',
      start: toIsoDate(row.ipoStartDate ?? ''),
      end: toIsoDate(row.ipoEndDate ?? ''),
      band: cleanText(row.priceRange),
      bandHigh: band.high,
      issuePrice: toNumber(String(row.issuePrice ?? '').trim()),
      listingDate: toIsoDate(row.listingDate ?? ''),
    };
  });
}

// NSE's lists of open and upcoming issues use their own field names.
export function parseLiveIssues(rows) {
  return rows.filter(isEquityIssue).map((row) => {
    const band = parsePriceBand(row.issuePrice ?? row.priceRange);
    return {
      symbol: String(row.symbol).trim(),
      name: cleanText(row.companyName),
      board: SME_TYPES.has(String(row.series ?? row.securityType).trim()) ? 'SME' : 'Main board',
      start: toIsoDate(row.issueStartDate ?? row.ipoStartDate ?? ''),
      end: toIsoDate(row.issueEndDate ?? row.ipoEndDate ?? ''),
      band: cleanText(row.issuePrice ?? row.priceRange),
      bandHigh: band.high,
      size: cleanText(row.issueSize),
      subscribedTimes: toNumber(String(row.noOfTime ?? '').trim()),
    };
  });
}

// NSE follows the cut-off time with a long paragraph of procedure.
const cutoffOnly = (text) => text.match(/^.*?\bPM\)?/i)?.[0] ?? text;

const safeDocumentUrl = (value) => {
  const url = String(value ?? '').match(/https:\/\/[^\s"'<>]+/)?.[0];
  return url && /^https:\/\/(nsearchives\.)?(www\.)?nseindia\.com\//.test(url) ? url : null;
};

export function parseIpoDetail(json) {
  const info = json?.issueInfo?.dataList ?? [];
  if (!info.length && !json?.bidDetails?.length) return null;

  const facts = {};
  const documents = [];
  for (const { title, value } of info) {
    const heading = String(title ?? '');
    const fact = FACTS.find(([prefix]) => heading.startsWith(prefix));
    if (fact && cleanText(value)) facts[fact[1]] = shorten(fact[1] === 'upiCutoff' ? cutoffOnly(cleanText(value)) : cleanText(value));
    const document = DOCUMENTS.find(([prefix]) => heading.startsWith(prefix));
    const url = document && safeDocumentUrl(value);
    if (url) documents.push({ name: document[1], url });
  }

  const subscription = (json.bidDetails ?? [])
    .filter(({ srNo, category }) => /^\d+(\.\d+)?$/.test(String(srNo)) || category === 'Total')
    .map(({ category, noOfTime }) => ({ category: cleanText(category), times: toNumber(String(noOfTime ?? '')) }))
    .filter(({ times }) => times !== null)
    .map(({ category, times }) => ({ category, times: round(times, 2) }));

  const allExchanges = toNumber(String(json.demandGraphALL?.noOfTimesIssueSubscribed ?? ''));
  const lotSize = facts.lot ? parsePriceBand(facts.lot).low : null;
  return {
    facts,
    documents,
    subscription,
    subscribedAllExchanges: allExchanges,
    subscriptionUpdated: cleanText(json.activeCat?.updateTime) || null,
    lotSize,
  };
}

const percentChange = (from, to) => round(((to - from) / from) * 100, 2);

// Listing-day figures from NSE's price reports, with the issue price on today's basis after any later split.
export function listingPerformance({ issuePrice, listingDate }, sessions, actions = []) {
  if (!listingDate || !sessions?.length) return null;
  const first = sessions.find((session) => session.date >= listingDate);
  if (!first) return null;
  const latest = sessions.at(-1);
  const factor = actions.filter((action) => action.date > first.date).reduce((product, action) => product * action.factor, 1);
  return {
    listingOpen: first.open,
    listingClose: first.close,
    listingGain: issuePrice ? percentChange(issuePrice, first.open) : null,
    latestClose: latest.close,
    latestDate: latest.date,
    returnSinceIssue: issuePrice ? percentChange(issuePrice * factor, latest.close) : null,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2, 2);
}

function summarise(issues) {
  const priced = issues.filter((issue) => issue.performance?.listingGain !== null && issue.performance?.listingGain !== undefined);
  const gains = priced.map((issue) => issue.performance.listingGain);
  if (!gains.length) return { count: issues.length, priced: 0 };
  const byGain = [...priced].sort((a, b) => a.performance.listingGain - b.performance.listingGain);
  const describe = (issue) => ({ name: issue.name, gain: issue.performance.listingGain });
  return {
    count: issues.length,
    priced: priced.length,
    medianGain: median(gains),
    positiveShare: round((gains.filter((gain) => gain > 0).length / gains.length) * 100, 0),
    best: describe(byGain.at(-1)),
    worst: describe(byGain[0]),
  };
}

export function summariseListings(issues) {
  const listed = issues.filter((issue) => issue.listingDate);
  return {
    mainBoard: summarise(listed.filter((issue) => issue.board === 'Main board')),
    sme: summarise(listed.filter((issue) => issue.board === 'SME')),
  };
}

export const normaliseCompany = (name) =>
  String(name)
    .toLowerCase()
    .replace(/\b(limited|ltd|private|pvt)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');

async function fetchJson(path) {
  const body = await download(`${API}/${path}`, HEADERS);
  return body ? JSON.parse(body.toString('utf8')) : null;
}

export async function fetchPastIssues() {
  const rows = await fetchJson('public-past-issues');
  if (!Array.isArray(rows)) throw new Error('NSE returned no list of past issues');
  return parsePastIssues(rows);
}

export async function fetchOpenIssues() {
  const rows = await fetchJson('ipo-current-issue');
  return Array.isArray(rows) ? parseLiveIssues(rows) : [];
}

export async function fetchUpcomingIssues() {
  const rows = await fetchJson('all-upcoming-issues?category=ipo');
  return Array.isArray(rows) ? parseLiveIssues(rows) : [];
}

// A listed issue's record never changes, so it's kept for good. An open one is refetched each day.
export async function fetchIssueDetail({ symbol, board, listingDate }) {
  const today = new Date().toISOString().slice(0, 10);
  const safeName = symbol.replace(/[^\w-]/g, '_');
  const key = listingDate ? `nse/ipo/${safeName}.json` : `nse/ipo-live/${today}/${safeName}.json`;
  const series = board === 'SME' ? 'SME' : 'EQ';
  const query = new URLSearchParams({ symbol, series });
  const body = await cachedDownload(key, `${API}/ipo-detail?${query}`, { headers: HEADERS });
  return body ? parseIpoDetail(JSON.parse(body.toString('utf8'))) : null;
}
