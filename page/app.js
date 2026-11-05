const market = createMarket(JSON.parse(document.querySelector('#market-data').textContent));
const site = JSON.parse(document.querySelector('#site-config').textContent);

const instrumentInput = document.querySelector('#instrument');
const suggestions = document.querySelector('#suggestions');
const dateInput = document.querySelector('#date');
const previousDay = document.querySelector('#previous-day');
const nextDay = document.querySelector('#next-day');
const result = document.querySelector('#result');
const announcer = document.querySelector('#announcer');
const presets = [...document.querySelectorAll('.presets button')];

const SEARCH_DELAY_MS = 120;
const SOURCE_NAMES = { nse: 'Official NSE data', yahoo: 'Yahoo Finance data' };
const SOURCE_CREDITS = { nse: 'NSE daily reports', yahoo: 'Yahoo Finance' };
// Long enough to cover India's longest market closures, so this only appears if updates have really stopped.
const STALE_AFTER_DAYS = 6;
const CRORE = 10_000_000;
const LAKH = 100_000;

let instrument = null; // { symbol, label }
let current = null;
let drawChart = null;
let searchTimer = null;
let options = [];
let activeOption = -1;

// Building nodes with textContent keeps text from outside sources out of the HTML parser.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

const locale = (currency) => (currency === 'INR' ? 'en-IN' : 'en-US');

function formatNumber(value, currency, decimals = 2) {
  return new Intl.NumberFormat(locale(currency), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatSigned(value, currency, decimals = 2) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${formatNumber(Math.abs(value), currency, decimals)}`;
}

function formatQuantity(value) {
  if (value >= CRORE) return `${formatNumber(value / CRORE, 'INR')} Cr`;
  if (value >= LAKH) return `${formatNumber(value / LAKH, 'INR')} L`;
  return formatNumber(value, 'INR', 0);
}

const formatCrore = (value) => formatNumber(value / CRORE, 'INR', 0);

const dateFrom = (iso) => new Date(`${iso}T00:00:00Z`);

function formatDate(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(dateFrom(iso));
}

const formatPlainDate = (iso) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(dateFrom(iso));

const formatShortDate = (iso) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(dateFrom(iso));

const formatYear = (iso) =>
  new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(dateFrom(iso));

const safeUrl = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : null);

function externalLink(url, text) {
  const href = safeUrl(url);
  if (!href) return text;
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

/* Pivot panel */

function renderHero(data) {
  const { instrument: item, session, date } = data;
  const price = (value) => formatNumber(value, item.currency, item.decimals);

  const readingText =
    session.closeVsPivot === 0
      ? `Close of ${price(session.close)} is at the pivot`
      : `Close of ${price(session.close)} is ${price(Math.abs(session.closeVsPivot))} (${formatNumber(Math.abs(session.closeVsPivotPercent), item.currency)}%) ${session.closeVsPivot > 0 ? 'above' : 'below'} the pivot`;

  const priceItem = (label, value, className) =>
    el('div', { class: className }, el('dt', {}, label), el('dd', {}, price(value)));

  const notes = data.laterActions.map((action) =>
    el(
      'p',
      { class: 'hero-note' },
      `These are the prices actually traded that day. A corporate action on ${formatPlainDate(action.date)} (such as a split, bonus or demerger) later changed the share price by a factor of ${formatNumber(action.factor, 'USD', 3)}, so they aren't directly comparable with today's price.`,
    ),
  );

  return el(
    'article',
    { class: 'hero' },
    el(
      'div',
      { class: 'hero-head' },
      el(
        'div',
        {},
        el('h2', {}, item.name),
        el('p', { class: 'hero-meta' }, [item.symbol === item.name ? null : item.symbol, item.exchange, item.currency].filter(Boolean).join(' · ')),
      ),
      el('span', { class: 'source-tag' }, SOURCE_NAMES[item.source]),
    ),
    el(
      'div',
      {},
      el('p', { class: 'pivot-label' }, el('strong', {}, 'Pivot point'), ` for ${formatDate(date)}`),
      el('div', { class: 'pivot-line' }, el('p', { class: 'pivot-value' }, price(session.pivot))),
      el('p', { class: 'pivot-reading' }, readingText),
    ),
    el(
      'dl',
      { class: 'hero-prices' },
      priceItem('Open', session.open),
      priceItem('High', session.high),
      priceItem('Low (not used)', session.low, 'unused'),
      priceItem('Close', session.close),
    ),
    el('p', { class: 'working' }, `(${price(session.open)} + ${price(session.high)} + ${price(session.close)}) ÷ 3 = ${price(session.pivot)}`),
    ...notes,
  );
}

function noSessionText(data) {
  const { instrument: item } = data;
  const date = formatDate(data.date);
  const source = SOURCE_CREDITS[item.source];
  switch (data.reason) {
    case 'ended':
      return {
        title: `No prices yet for ${date}`,
        body: `This page has ${item.name} prices up to ${formatDate(data.previousSession)}.`,
      };
    case 'missing':
      return {
        title: `No prices for ${date}`,
        body: `The market was open, but ${source} has no prices for ${item.name} on this day.`,
      };
    case 'before':
      return {
        title: `No prices for ${date}`,
        body: `This page's ${item.name} prices start on ${formatDate(data.nextSession)}.`,
      };
    default:
      return {
        title: `No trading on ${date}`,
        body: `${item.name} has no prices for this date because the market was closed for a weekend or holiday.`,
      };
  }
}

function renderNoSession(data) {
  const { title, body } = noSessionText(data);
  const buttons = [];
  if (data.previousSession) {
    buttons.push(el('button', { type: 'button', onclick: () => goToDate(data.previousSession) }, `← ${formatDate(data.previousSession)}`));
  }
  if (data.nextSession) {
    buttons.push(el('button', { type: 'button', onclick: () => goToDate(data.nextSession) }, `${formatDate(data.nextSession)} →`));
  }
  return el(
    'article',
    { class: 'hero is-message' },
    el('p', { class: 'message-title' }, title),
    el('p', { class: 'message-body' }, body),
    buttons.length ? el('div', { class: 'actions' }, ...buttons) : null,
  );
}

/* Chart */

function legendKey(kind) {
  const svg = (children) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('width', '14');
    node.setAttribute('height', '14');
    node.setAttribute('viewBox', '0 0 14 14');
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = children;
    return node;
  };
  if (kind === 'up') return svg('<rect x="3" y="2" width="8" height="10" rx="1" fill="none" stroke="var(--up)" stroke-width="1.5"/>');
  if (kind === 'down') return svg('<rect x="3" y="2" width="8" height="10" rx="1" fill="var(--down)"/>');
  return svg('<path d="M0 7h14" stroke="var(--pivot)" stroke-width="2"/>');
}

function renderChartCard(data) {
  const { instrument: item, session, chart } = data;
  const host = el('div', {
    class: 'chart-host',
    tabindex: '0',
    role: 'group',
    'data-refocus': 'chart',
    'aria-label': 'Price chart. Use the left and right arrow keys to read sessions, and Enter to choose one.',
  });

  drawChart = () =>
    renderChart(host, {
      bars: chart.bars,
      selectedIndex: chart.selectedIndex,
      pivot: session.pivot,
      formatPrice: (value) => formatNumber(value, item.currency, item.decimals),
      formatAxis: (value, decimals) => formatNumber(value, item.currency, decimals),
      formatDate,
      formatShortDate,
      onSelect: goToDate,
    });

  return el(
    'article',
    { class: 'chart-card' },
    el(
      'div',
      { class: 'chart-head' },
      el('h3', {}, 'Price around this session'),
      el(
        'ul',
        { class: 'legend' },
        el('li', {}, legendKey('up'), 'Closed up'),
        el('li', {}, legendKey('down'), 'Closed down'),
        el('li', {}, legendKey('pivot'), `Pivot for ${formatShortDate(data.date)}`),
      ),
    ),
    host,
    chart.rescaledFor.length
      ? el(
          'p',
          { class: 'chart-note' },
          `A corporate action on ${chart.rescaledFor.map(formatPlainDate).join(' and ')} falls in this period. Candles are rescaled to this session's price basis, and the table shows the prices actually traded.`,
        )
      : null,
  );
}

/* Fundamentals */

function stat(label, value, { className, isText } = {}) {
  if (value === null || value === undefined || value === '') return null;
  return el('div', { class: 'stat' }, el('dt', {}, label), el('dd', { class: [className, isText ? 'is-text' : null].filter(Boolean).join(' ') || null }, value));
}

const directionClass = (value) => (value > 0 ? 'is-up' : value < 0 ? 'is-down' : null);
const statGroup = (className, ...stats) => {
  const present = stats.filter(Boolean);
  return present.length ? el('dl', { class: ['stats', className].filter(Boolean).join(' ') }, ...present) : null;
};

function sectionHead(title, note) {
  return el('div', { class: 'section-head' }, el('h3', { class: 'section-title' }, title), note ? el('p', { class: 'section-note' }, note) : null);
}

function renderSessionStats(data) {
  const { instrument: item, session, range } = data;
  const percent = (value) => `${formatSigned(value, item.currency)}%`;
  return el(
    'section',
    {},
    sectionHead(`On ${formatDate(data.date)}`, `Source: ${SOURCE_CREDITS[item.source]}`),
    statGroup(
      null,
      session.change === null
        ? null
        : stat('Change on the day', `${formatSigned(session.change, item.currency, item.decimals)} (${percent(session.changePercent)})`, { className: directionClass(session.change) }),
      range.yearReturn === null ? null : stat('1-year return', percent(range.yearReturn), { className: directionClass(range.yearReturn) }),
      session.volume ? stat('Volume', formatQuantity(session.volume)) : null,
      session.delivery === null ? null : stat('Delivery', `${formatNumber(session.delivery, item.currency)}%`),
      session.pe === null ? null : stat('P/E', formatNumber(session.pe, item.currency)),
      session.pb === null ? null : stat('P/B', formatNumber(session.pb, item.currency)),
      session.dividendYield === null ? null : stat('Dividend yield', `${formatNumber(session.dividendYield, item.currency)}%`),
    ),
  );
}

function renderRange(data) {
  const { instrument: item, range } = data;
  const price = (value) => formatNumber(value, item.currency, item.decimals);
  const title = range.coversYear ? '52-week range' : `Range since ${formatPlainDate(range.from)}`;
  return el(
    'section',
    { class: 'range' },
    sectionHead(title, `Close of ${price(data.session.close)} marked`),
    el(
      'div',
      { class: 'range-track', role: 'img', 'aria-label': `The close sits ${Math.round(range.position * 100)}% of the way from the low of ${price(range.low)} to the high of ${price(range.high)}.` },
      el('span', { class: 'range-marker', style: `left: ${(range.position * 100).toFixed(1)}%` }),
    ),
    el(
      'div',
      { class: 'range-ends' },
      el('div', {}, el('strong', {}, price(range.low)), el('span', {}, `Low, ${formatPlainDate(range.lowDate)}`)),
      el('div', {}, el('strong', {}, price(range.high)), el('span', {}, `High, ${formatPlainDate(range.highDate)}`)),
    ),
  );
}

function renderProfile(item) {
  const { profile } = item;
  if (!profile) return null;
  const number = (value) => (value === null ? null : formatNumber(value, 'INR'));
  return el(
    'section',
    {},
    sectionHead('Company', `Latest, as of ${formatPlainDate(profile.asOf)}. Source: NSE daily reports`),
    statGroup(
      'is-company',
      profile.marketCap ? stat('Market cap', `₹${formatCrore(profile.marketCap)} Cr`) : null,
      stat('P/E', number(profile.pe)),
      stat('Adjusted P/E', number(profile.adjustedPe)),
      profile.shares ? stat('Shares issued', formatQuantity(profile.shares)) : null,
      stat('Face value', profile.faceValue === null ? null : `₹${formatNumber(profile.faceValue, 'INR', profile.faceValue % 1 ? 2 : 0)}`),
      stat('Sector', profile.industry, { isText: true }),
      profile.listed ? stat('Listed since', formatPlainDate(profile.listed), { isText: true }) : null,
      stat('ISIN', profile.isin, { isText: true }),
    ),
  );
}

function renderFinancials(item) {
  const rows = item.financials ?? [];
  if (!rows.length) return null;
  // Borrowing is a bank's raw material, so debt to equity says little about a lender.
  const showDebt = item.profile?.industry !== 'Financial Services';
  const cell = (value, format) => (value === null ? '–' : format(value));
  const ratio = (top, bottom) => (top === null || !bottom ? null : top / bottom);
  return el(
    'section',
    {},
    sectionHead('Annual financials', 'Source: Yahoo Finance. ₹ crore except per-share figures'),
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { scope: 'col' }, 'Year to'),
            el('th', { scope: 'col' }, 'Revenue'),
            el('th', { scope: 'col' }, 'Net profit'),
            el('th', { scope: 'col' }, 'EPS (₹)'),
            el('th', { scope: 'col' }, 'Return on equity'),
            showDebt ? el('th', { scope: 'col' }, 'Debt ÷ equity') : null,
          ),
        ),
        el(
          'tbody',
          {},
          ...[...rows].reverse().map((row) =>
            el(
              'tr',
              {},
              el('td', {}, formatYear(row.year)),
              el('td', {}, cell(row.revenue, formatCrore)),
              el('td', {}, cell(row.profit, formatCrore)),
              el('td', {}, cell(row.eps, (value) => formatNumber(value, 'INR'))),
              el('td', {}, cell(ratio(row.profit, row.equity), (value) => `${formatNumber(value * 100, 'INR', 1)}%`)),
              showDebt ? el('td', {}, cell(ratio(row.debt, row.equity), (value) => formatNumber(value, 'INR'))) : null,
            ),
          ),
        ),
      ),
    ),
  );
}

/* Sessions table: the chart's table-view twin, always showing the prices actually traded. */

function renderSessions(data) {
  const { instrument: item, chart } = data;
  const price = (value) => formatNumber(value, item.currency, item.decimals);
  const rows = [...chart.bars].reverse().map((bar) =>
    el(
      'tr',
      { class: bar.date === data.date ? 'is-selected' : null, 'aria-current': bar.date === data.date ? 'date' : null },
      el(
        'td',
        {},
        el('button', { type: 'button', class: 'row-button', 'data-refocus': `session-${bar.date}`, onclick: () => goToDate(bar.date) }, formatPlainDate(bar.date)),
      ),
      el('td', { class: 'pivot-cell' }, price(bar.pivot)),
      el('td', {}, price(bar.open)),
      el('td', {}, price(bar.high)),
      el('td', {}, price(bar.low)),
      el('td', {}, price(bar.close)),
    ),
  );
  const wrap = el(
    'div',
    { class: 'table-scroll is-tall', tabindex: '0', role: 'region', 'aria-label': 'Sessions around the selected date' },
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          ...['Date', 'Pivot', 'Open', 'High', 'Low', 'Close'].map((heading) => el('th', { scope: 'col' }, heading)),
        ),
      ),
      el('tbody', {}, ...rows),
    ),
  );
  return el('section', {}, sectionHead('Pivot by session', 'Choose a date to see its pivot'), wrap);
}

/* News and exchange notices */

function renderUpcoming(item) {
  if (!item.upcoming?.length) return null;
  return el(
    'section',
    {},
    sectionHead('Coming up', 'Source: NSE'),
    el(
      'ul',
      { class: 'feed' },
      ...item.upcoming.map((event) =>
        el('li', {}, el('p', { class: 'feed-title' }, `${event.kind}, ${formatPlainDate(event.date)}`), el('p', { class: 'feed-meta' }, event.text)),
      ),
    ),
  );
}

function renderFilings(item) {
  if (!item.filings?.length) return null;
  return el(
    'section',
    {},
    sectionHead('Filings with NSE', 'Last 8 trading days'),
    el(
      'ul',
      { class: 'feed' },
      ...item.filings.map((filing) =>
        el(
          'li',
          {},
          el('p', { class: 'feed-title' }, filing.category),
          el('p', { class: 'feed-meta' }, filing.text ? `${formatPlainDate(filing.date)}. ${filing.text}` : formatPlainDate(filing.date)),
        ),
      ),
    ),
  );
}

function renderNews(item) {
  const links = el(
    'p',
    { class: 'links' },
    item.newsUrl ? externalLink(item.newsUrl, 'Latest news ↗') : null,
    item.officialUrl ? externalLink(item.officialUrl, 'Official page ↗') : null,
  );
  return el(
    'section',
    {},
    sectionHead('News', `Collected on ${formatPlainDate(market.builtOn)}`),
    item.news.length
      ? el(
          'ul',
          { class: 'feed' },
          ...item.news.map((story) =>
            el(
              'li',
              {},
              el('p', { class: 'feed-title' }, externalLink(story.url, story.title)),
              el('p', { class: 'feed-meta' }, `${story.publisher}, ${formatPlainDate(story.date)}`),
            ),
          ),
        )
      : el('p', { class: 'empty' }, 'No recent headlines from the publishers this page trusts.'),
    links,
  );
}

/* Page */

function renderPrompt(message) {
  drawChart = null;
  result.replaceChildren(el('article', { class: 'hero is-message' }, el('p', { class: 'message-body' }, message)));
}

function render() {
  if (!dateInput.value || !dateInput.validity.valid) {
    previousDay.disabled = true;
    nextDay.disabled = true;
    return renderPrompt(`Choose a date between ${formatPlainDate(dateInput.min)} and ${formatPlainDate(dateInput.max)}.`);
  }

  const refocus = document.activeElement?.dataset?.refocus;
  const data = market.lookup(instrument.symbol, dateInput.value);
  current = data;
  previousDay.disabled = !data.previousSession;
  nextDay.disabled = !data.nextSession;

  const { instrument: item, session } = data;
  const sections = [];
  drawChart = null;

  if (session) {
    sections.push(el('div', { class: 'primary' }, renderHero(data), renderChartCard(data)));
    sections.push(
      el(
        'div',
        { class: 'fundamentals' },
        renderSessionStats(data),
        el('div', { class: item.profile ? 'about-row' : null }, renderRange(data), renderProfile(item)),
        renderFinancials(item),
      ),
    );
  } else {
    sections.push(el('div', { class: 'primary' }, renderNoSession(data)));
    const about = [renderProfile(item), renderFinancials(item)].filter(Boolean);
    if (about.length) sections.push(el('div', { class: 'fundamentals' }, ...about));
  }

  sections.push(
    el(
      'div',
      { class: 'secondary' },
      session ? renderSessions(data) : null,
      el('div', { class: 'news-column' }, renderUpcoming(item), renderNews(item), renderFilings(item)),
    ),
  );

  result.replaceChildren(...sections);
  drawChart?.();

  const selectedRow = result.querySelector('tr.is-selected');
  const scroller = selectedRow?.closest('.is-tall');
  if (scroller) scroller.scrollTop = Math.max(0, selectedRow.offsetTop - scroller.clientHeight / 2);

  if (refocus) result.querySelector(`[data-refocus="${CSS.escape(refocus)}"]`)?.focus({ preventScroll: true });

  announcer.textContent = session
    ? `${item.name}: pivot ${formatNumber(session.pivot, item.currency, item.decimals)} for ${formatDate(data.date)}.`
    : noSessionText(data).title;
}

function goToDate(iso) {
  dateInput.value = iso;
  render();
}

function selectInstrument(symbol, label) {
  instrument = { symbol, label };
  instrumentInput.value = label;
  for (const button of presets) {
    button.setAttribute('aria-pressed', String(button.dataset.symbol === symbol));
  }
  render();
}

/* Search box */

function closeSuggestions() {
  clearTimeout(searchTimer);
  suggestions.hidden = true;
  options = [];
  activeOption = -1;
  instrumentInput.setAttribute('aria-expanded', 'false');
  instrumentInput.removeAttribute('aria-activedescendant');
}

function showSuggestionsMessage(message) {
  options = [];
  activeOption = -1;
  suggestions.replaceChildren(el('li', { class: 'suggestions-message' }, message));
  suggestions.hidden = false;
  instrumentInput.setAttribute('aria-expanded', 'true');
  instrumentInput.removeAttribute('aria-activedescendant');
}

function chooseOption(option) {
  closeSuggestions();
  selectInstrument(option.symbol, option.label ?? option.name);
  instrumentInput.blur();
}

function showOptions(results) {
  if (!results.length) return showSuggestionsMessage(`No matches. This page covers ${market.coverage}.`);

  options = results;
  activeOption = -1;
  suggestions.replaceChildren(
    ...results.map((option, index) =>
      el(
        'li',
        {
          id: `option-${index}`,
          role: 'option',
          'aria-selected': 'false',
          // Keeps focus in the input so its blur handler doesn't close the list before the click lands.
          onmousedown: (event) => event.preventDefault(),
          onclick: () => chooseOption(option),
        },
        el('span', { class: 'option-name' }, option.name),
        el('span', { class: 'option-meta' }, [option.symbol === option.name ? null : option.symbol, option.exchange, option.type].filter(Boolean).join(' · ')),
      ),
    ),
  );
  suggestions.hidden = false;
  instrumentInput.setAttribute('aria-expanded', 'true');
  instrumentInput.removeAttribute('aria-activedescendant');
}

function highlightOption(index) {
  activeOption = index;
  [...suggestions.children].forEach((item, i) => {
    item.setAttribute('aria-selected', String(i === index));
    if (i === index) item.scrollIntoView({ block: 'nearest' });
  });
  instrumentInput.setAttribute('aria-activedescendant', `option-${index}`);
}

instrumentInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = instrumentInput.value.trim();
  if (!query) return closeSuggestions();
  searchTimer = setTimeout(() => showOptions(market.search(query)), SEARCH_DELAY_MS);
});

instrumentInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeSuggestions();
  } else if (event.key === 'ArrowDown' && options.length) {
    event.preventDefault();
    highlightOption((activeOption + 1) % options.length);
  } else if (event.key === 'ArrowUp' && options.length) {
    event.preventDefault();
    highlightOption((activeOption - 1 + options.length) % options.length);
  } else if (event.key === 'Enter' && options.length) {
    event.preventDefault();
    chooseOption(options[Math.max(activeOption, 0)]);
  }
});

instrumentInput.addEventListener('focus', () => instrumentInput.select());

// Leaving the box without choosing puts back the instrument the page is showing.
instrumentInput.addEventListener('blur', () => {
  closeSuggestions();
  if (instrument) instrumentInput.value = instrument.label;
});

/* Wiring */

document.querySelector('#controls').addEventListener('submit', (event) => event.preventDefault());
dateInput.addEventListener('change', render);
previousDay.addEventListener('click', () => current?.previousSession && goToDate(current.previousSession));
nextDay.addEventListener('click', () => current?.nextSession && goToDate(current.nextSession));
for (const button of presets) {
  button.addEventListener('click', () => selectInstrument(button.dataset.symbol, button.textContent));
}

let lastWidth = 0;
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width !== lastWidth) {
    lastWidth = entry.contentRect.width;
    drawChart?.();
  }
}).observe(result);

instrumentInput.placeholder = `Search ${market.coverage}`;
dateInput.min = market.minDate;
dateInput.max = market.maxDate;

const status = document.querySelector('#data-status');
const dataAgeDays = (Date.now() - Date.parse(market.maxDate)) / 86_400_000;
const isStale = site.autoUpdates && dataAgeDays > STALE_AFTER_DAYS;
const updateLabel = !site.autoUpdates ? 'Not live' : isStale ? 'Updates may have stopped' : 'Updates every evening';
status.textContent = `Prices to ${formatDate(market.maxDate)} · News from ${formatPlainDate(market.builtOn)} · ${updateLabel}`;
status.classList.toggle('is-stale', isStale);
document.querySelector('#update-note').textContent = site.autoUpdates
  ? 'New prices and news arrive every evening, India time, once NSE publishes its reports. Figures are from the finished trading days shown at the top.'
  : "This copy doesn't update, so its prices and news stay as they were on the dates shown at the top.";
if (site.currentUrl) {
  const moved = document.querySelector('#moved-note');
  moved.replaceChildren('This copy no longer updates. ', externalLink(site.currentUrl, 'Open the live site ↗'));
  moved.hidden = false;
}

dateInput.value = market.maxDate;
selectInstrument(presets[0].dataset.symbol, presets[0].textContent);
