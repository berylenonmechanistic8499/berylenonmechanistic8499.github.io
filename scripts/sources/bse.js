// BSE's own daily price file, used for companies that trade only on BSE.
import { cachedDownload } from './http.js';
import { splitCsvLine, toNumber } from './nse.js';

// Equity groups. The file's other groups are bonds, funds and government securities.
const EQUITY_GROUPS = new Set(['A', 'B', 'T', 'X', 'XT', 'Z', 'M', 'MT', 'MS']);
const SETTLED_AFTER_DAYS = 4;

function downloadReport(iso) {
  const compact = iso.replaceAll('-', '');
  return cachedDownload(
    `bse/prices/${iso}.csv`,
    `https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${compact}_F_0000.CSV`,
    {
      keepMissing: Date.now() - Date.parse(iso) > SETTLED_AFTER_DAYS * 86_400_000,
      // The first column of the first row is the trading date, which rejects error pages and other days' files.
      isValid: (buffer) => buffer.toString('utf8', 0, 900).split(/\r?\n/, 2)[1]?.startsWith(iso) ?? false,
    },
  );
}

export async function hasBseReport(iso) {
  return Boolean(await downloadReport(iso));
}

export function parseBseRows(text) {
  const [header, ...lines] = text.split(/\r?\n/);
  const columns = splitCsvLine(header);
  const at = (name) => columns.indexOf(name);
  const [code, isin, symbol, group, name, open, high, low, close, volume] = [
    'FinInstrmId',
    'ISIN',
    'TckrSymb',
    'SctySrs',
    'FinInstrmNm',
    'OpnPric',
    'HghPric',
    'LwPric',
    'ClsPric',
    'TtlTradgVol',
  ].map(at);
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    const cells = splitCsvLine(line);
    if (!EQUITY_GROUPS.has(cells[group]) || !cells[isin]?.startsWith('IN')) continue;
    rows.push({
      code: cells[code],
      isin: cells[isin],
      symbol: cells[symbol],
      group: cells[group],
      name: cells[name],
      open: toNumber(cells[open]),
      high: toNumber(cells[high]),
      low: toNumber(cells[low]),
      close: toNumber(cells[close]),
      volume: toNumber(cells[volume]),
    });
  }
  return rows;
}

export async function fetchBseRows(iso) {
  const body = await downloadReport(iso);
  return body ? parseBseRows(body.toString('utf8')) : null;
}

export function bsePageUrl(name, symbol, code) {
  const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://www.bseindia.com/stock-share-price/${slug(name)}/${slug(symbol)}/${code}/`;
}
