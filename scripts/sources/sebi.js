// SEBI's official lists of IPO documents: drafts awaiting review and final red herring prospectuses.
import { decodeEntities } from './news.js';
import { download } from './http.js';

const LIST_URL = 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=3&ssid=15&smid=';
export const SEBI_RHP_LIST = 11;
export const SEBI_DRAFT_LIST = 10;

const ROW = /<td[^>]*>\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*<\/td>\s*<td[^>]*>\s*<a href="(https:\/\/www\.sebi\.gov\.in\/filings\/public-issues\/[^"]+)"[^>]*title="([^"]*)"/g;
const DOCUMENT_WORDS = /\s*[-–:]\s*((?:addendum|corrigendum|notice|public announcement|price band|udrhp|drhp|rhp)\b.*)$/i;

const isoFrom = (text) => new Date(`${text} UTC`).toISOString().slice(0, 10);

export function splitFilingTitle(title) {
  const clean = decodeEntities(title.split('<')[0]).replace(/\s+/g, ' ').trim();
  const match = clean.match(DOCUMENT_WORDS);
  if (!match) return { company: clean, document: 'Filing' };
  return { company: clean.slice(0, match.index).trim(), document: match[1].trim() };
}

// One entry per company, newest first, with each of its documents.
export function parseSebiList(html) {
  const companies = new Map();
  for (const [, date, url, title] of html.matchAll(ROW)) {
    const { company, document } = splitFilingTitle(title);
    if (!company) continue;
    const key = company.toLowerCase();
    if (!companies.has(key)) companies.set(key, { company, date: isoFrom(date), documents: [] });
    companies.get(key).documents.push({ name: document, date: isoFrom(date), url });
  }
  return [...companies.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export async function fetchSebiList(listId) {
  const body = await download(`${LIST_URL}${listId}`);
  return body ? parseSebiList(body.toString('utf8')) : [];
}
