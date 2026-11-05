// Headlines from Google News, kept only when they come from a named, established publisher.
import { cachedDownload } from './http.js';

const HEADLINES_PER_INSTRUMENT = 5;
const MAX_AGE_DAYS = 45;

export const TRUSTED_PUBLISHERS = new Set([
  'Reuters',
  'Bloomberg',
  'Bloomberg.com',
  'The Economic Times',
  'Economic Times',
  'ET Now',
  'Moneycontrol',
  'Moneycontrol.com',
  'Livemint',
  'Mint',
  'Business Standard',
  'CNBC TV18',
  'CNBCTV18',
  'BusinessLine',
  'The Hindu BusinessLine',
  'NDTV Profit',
  'Financial Express',
  'The Financial Express',
  'Business Today',
  'CNBC',
  'The Wall Street Journal',
  'WSJ',
  'Financial Times',
  'MarketWatch',
  "Barron's",
  'AP News',
]);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, code) => {
    if (code[0] !== '#') return ENTITIES[code] ?? whole;
    const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
  });
}

const tag = (item, name) => {
  const match = item.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return match ? decodeEntities(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()) : '';
};

export function parseHeadlines(xml, { now = Date.now(), isRelevant = () => true } = {}) {
  const seen = new Set();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map(([, item]) => {
      const publisher = tag(item, 'source');
      const suffix = ` - ${publisher}`;
      const full = tag(item, 'title');
      return {
        title: full.endsWith(suffix) ? full.slice(0, -suffix.length) : full,
        publisher,
        url: tag(item, 'link'),
        time: Date.parse(tag(item, 'pubDate')),
      };
    })
    .filter(({ title, publisher, url, time }) => {
      if (!title || !TRUSTED_PUBLISHERS.has(publisher)) return false;
      if (!url.startsWith('https://news.google.com/')) return false;
      if (!Number.isFinite(time) || now - time > MAX_AGE_DAYS * 86_400_000) return false;
      return isRelevant(title);
    })
    .sort((a, b) => b.time - a.time)
    .filter(({ title }) => {
      const key = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, HEADLINES_PER_INSTRUMENT)
    .map(({ title, publisher, url, time }) => ({
      title,
      publisher,
      url,
      date: new Date(time).toISOString().slice(0, 10),
    }));
}

export function newsSearchUrl(query, region = 'IN') {
  const params = new URLSearchParams({
    q: query,
    hl: region === 'IN' ? 'en-IN' : 'en-US',
    gl: region,
    ceid: `${region}:en`,
  });
  return `https://news.google.com/search?${params}`;
}

export async function fetchHeadlines({ key, query, region = 'IN', isRelevant }) {
  const today = new Date().toISOString().slice(0, 10);
  const params = new URLSearchParams({
    q: `${query} when:30d`,
    hl: region === 'IN' ? 'en-IN' : 'en-US',
    gl: region,
    ceid: `${region}:en`,
  });
  const body = await cachedDownload(
    `news/${today}/${key.replace(/[^\w-]/g, '_')}.xml`,
    `https://news.google.com/rss/search?${params}`,
  );
  return body ? parseHeadlines(body.toString('utf8'), { isRelevant }) : [];
}
