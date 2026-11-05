// The IPO section: what's open, what recently listed, what's in the pipeline, and how IPOs work.
const IPO_PAGE_SIZE = 40;
// An older prospectus has usually run its course, so it stays in the filings tab only.
const FINAL_STAGE_DAYS = 30;
// Main-board listings follow within days of bidding closing, so anything older isn't still waiting.
const AWAITING_LISTING_DAYS = 10;

const ALLOTMENT_LINKS = [
  ['NSE: check your bid', 'https://www.nseindia.com/invest/check-trades-bids-verify-ipo-bids'],
  ['BSE: check your application', 'https://www.bseindia.com/investors/appli_check.aspx'],
  ['KFin Technologies', 'https://kosmic.kfintech.com/ipostatus/'],
  ['MUFG Intime (Link Intime)', 'https://in.mpms.mufg.com/Initial_Offer/public-issues.html'],
  ['Bigshare Services', 'https://ipo.bigshareonline.com/ipo_status.html'],
];

const IPO_STEPS = [
  ['Draft filed', 'The company files a draft prospectus (DRHP) with SEBI, describing its business, finances, risks and plans for the money.'],
  ['SEBI reviews', 'SEBI asks questions and gives its observations. Only then can the company go ahead.'],
  ['Price band announced', 'The final red herring prospectus (RHP) is filed, and the price band and lot size are announced.'],
  ['Anchor investors', 'Large institutions can buy a portion the day before bidding opens.'],
  ['Bidding', 'Usually three working days. You apply through your broker or bank using ASBA or UPI, and the money stays blocked in your account.'],
  ['Allotment', 'Shares are allotted the day after bidding closes. An oversubscribed issue uses a lottery or a proportional formula.'],
  ['Refund and credit', 'Money is unblocked for shares not allotted, and allotted shares reach your demat account.'],
  ['Listing', 'Main-board shares start trading three working days after bidding closes (known as T+3).'],
];

const IPO_TERMS = [
  ['Price band', 'The lowest and highest price you can bid. Most retail investors bid at the top, called the cut-off price, to avoid being left out.'],
  ['Lot size', 'The smallest number of shares you can apply for. Applications come in multiples of it.'],
  ['QIB, NII and retail', 'Investor categories. QIBs are institutions, NIIs are wealthy individuals and companies applying above ₹2 lakh, and retail is individuals applying up to ₹2 lakh.'],
  ['Subscribed (times)', 'How many times the shares on offer were bid for. 10 times means bids for ten times as many shares as were available.'],
  ['Fresh issue and offer for sale', "A fresh issue raises new money for the company. In an offer for sale, existing owners sell their shares and the company receives nothing."],
  ['ASBA and UPI', 'Ways to apply that block the money in your bank account until allotment, instead of taking it. UPI applications are limited to ₹5 lakh.'],
  ['Main board and SME', 'SME IPOs are smaller companies on separate platforms, with larger minimum investments and generally higher risk.'],
];

const ipoStatusOf = (issue) => {
  if (issue.listingDate) return `Listed ${formatPlainDate(issue.listingDate)}`;
  return `Bidding closed ${formatPlainDate(issue.end)}`;
};

function percentCell(value) {
  if (value === null || value === undefined) return el('td', {}, '–');
  return el('td', { class: directionClass(value) }, `${formatSigned(value)}%`);
}

function subscriptionBars(detail) {
  const rows = detail?.subscription ?? [];
  if (!rows.length) return null;
  const largest = Math.max(...rows.map(({ times }) => times), 1);
  return el(
    'div',
    { class: 'subscription' },
    el('h4', {}, 'Subscription'),
    detail.subscribedAllExchanges ? el('p', { class: 'subscription-total' }, `${formatNumber(detail.subscribedAllExchanges)} times overall, across exchanges`) : null,
    el(
      'ul',
      { class: 'bars' },
      ...rows.map(({ category, times }) =>
        el(
          'li',
          {},
          el('span', { class: 'bar-label' }, category),
          el('span', { class: 'bar-value' }, `${formatNumber(times)}×`),
          el('span', { class: 'bar-track' }, el('span', { class: 'bar-fill', style: `width: ${Math.max(1, (times / largest) * 100).toFixed(1)}%` })),
        ),
      ),
    ),
    el('p', { class: 'section-note' }, `Category figures are bids on NSE only.${detail.subscriptionUpdated ? ` ${detail.subscriptionUpdated}.` : ''}`),
  );
}

function issueFacts(issue) {
  const facts = issue.detail?.facts ?? {};
  const { lotSize } = issue.detail ?? {};
  const price = issue.bandHigh;
  const period = issue.start && issue.end ? `${formatPlainDate(issue.start)} to ${formatPlainDate(issue.end)}` : null;
  const rows = [
    ['Bidding period', period],
    ['Price band', facts.band ?? issue.band],
    ['Issue price', issue.issuePrice ? formatRupees(issue.issuePrice) : null],
    ['Lot size', lotSize ? `${formatNumber(lotSize, 'INR', 0)} shares` : facts.lot],
    ['Minimum investment', lotSize && price ? `${formatRupees(lotSize * price)} at the top of the band` : null],
    ['Issue size', facts.size],
    ['Issue type', facts.type],
    ['Retail limit', facts.retailLimit],
    ['UPI mandate cut-off', facts.upiCutoff],
    ['Lead managers', facts.managers],
    ['Registrar', facts.registrar],
    ['Sponsor bank', facts.sponsorBank],
    ['Listing-day open', issue.performance ? formatRupees(issue.performance.listingOpen) : null],
    ['Listing-day close', issue.performance ? formatRupees(issue.performance.listingClose) : null],
  ].filter(([, value]) => value);
  return el('dl', { class: 'facts' }, ...rows.map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', {}, value))));
}

function issueDetail(issue, onOpenStock) {
  const documents = issue.detail?.documents ?? [];
  const canOpen = onOpenStock.canOpen(issue.symbol);
  return el(
    'div',
    { class: 'issue-detail' },
    issueFacts(issue),
    el(
      'div',
      { class: 'issue-side' },
      subscriptionBars(issue.detail),
      documents.length
        ? el('div', {}, el('h4', {}, 'Official documents'), el('ul', { class: 'doc-links' }, ...documents.map(({ name, url }) => el('li', {}, externalLink(url, `${name} ↗`)))))
        : null,
      canOpen ? el('button', { type: 'button', class: 'primary-button', onclick: () => onOpenStock.open(issue.symbol) }, 'See this stock’s pivot') : null,
    ),
  );
}

function issueCard(issue, statusText, onOpenStock) {
  return el(
    'article',
    { class: 'issue-card' },
    el(
      'header',
      {},
      el('div', {}, el('h3', {}, issue.name), el('p', { class: 'section-note' }, [issue.symbol, issue.board].filter(Boolean).join(' · '))),
      el('span', { class: 'chip' }, statusText),
    ),
    issueDetail(issue, onOpenStock),
  );
}

function filingRow(filing) {
  let status = null;
  if (filing.listingDate) status = `Listed ${formatPlainDate(filing.listingDate)}`;
  else if (filing.cancelled) status = filing.cancelled === 'withdrawn' ? 'Withdrawn' : 'Postponed';
  else if (filing.closed) status = 'Bidding closed';
  return el(
    'li',
    { class: 'filing' },
    el(
      'div',
      { class: 'filing-head' },
      el('p', { class: 'feed-title' }, filing.company),
      status ? el('span', { class: 'chip' }, status) : null,
    ),
    el('p', { class: 'feed-meta' }, `Latest filing ${formatPlainDate(filing.date)}`),
    el('p', { class: 'doc-inline' }, ...filing.documents.slice(0, 4).flatMap(({ name, url }) => [externalLink(url, `${name} ↗`), ' '])),
  );
}

function openAndUpcomingTab(data, onOpenStock) {
  const asOf = Date.parse(data.asOf);
  const daysSince = (date) => (asOf - Date.parse(date)) / 86_400_000;
  const closedAwaiting = data.recent.filter((issue) => !issue.listingDate && !issue.cancelled && daysSince(issue.end) <= AWAITING_LISTING_DAYS);
  const finalStage = data.rhpFiled.filter((filing) => !filing.symbol && daysSince(filing.date) <= FINAL_STAGE_DAYS);
  const hasLive = data.open.length || data.upcoming.length;
  return el(
    'div',
    { class: 'ipo-tab' },
    data.open.length
      ? el('section', {}, sectionHead('Open for bidding on NSE', `As of ${formatPlainDate(data.asOf)}`), el('div', { class: 'issue-grid' }, ...data.open.map((issue) => issueCard(issue, `Closes ${formatPlainDate(issue.end)}`, onOpenStock))))
      : null,
    data.upcoming.length
      ? el('section', {}, sectionHead('Scheduled on NSE', `As of ${formatPlainDate(data.asOf)}`), el('div', { class: 'issue-grid' }, ...data.upcoming.map((issue) => issueCard(issue, issue.start ? `Opens ${formatPlainDate(issue.start)}` : 'Upcoming', onOpenStock))))
      : null,
    hasLive
      ? null
      : el(
          'div',
          { class: 'notice' },
          el('p', { class: 'feed-title' }, `NSE shows no IPOs open or scheduled, as of ${formatPlainDate(data.asOf)}`),
          el(
            'p',
            { class: 'feed-meta' },
            `IPOs that list only on BSE don’t appear in NSE’s list, so one could still be open. ${finalStage.length ? 'The companies below have filed their final prospectus, which is the best official sign of what’s coming.' : 'SEBI’s latest prospectuses are under SEBI filings.'}`,
          ),
        ),
    finalStage.length
      ? el(
          'section',
          {},
          sectionHead('At the final filing stage', 'Source: SEBI. Red herring prospectus filed, and not yet on NSE’s record'),
          el('p', { class: 'section-intro' }, 'Each of these could be about to open, open now, or listing only on BSE. The prospectus gives the dates.'),
          el('ul', { class: 'feed' }, ...finalStage.map(filingRow)),
        )
      : null,
    closedAwaiting.length
      ? el(
          'section',
          {},
          sectionHead('Bidding closed, awaiting listing', 'Source: NSE'),
          el('div', { class: 'issue-grid' }, ...closedAwaiting.map((issue) => issueCard(issue, ipoStatusOf(issue), onOpenStock))),
        )
      : null,
  );
}

function recentlyListedTab(data, onOpenStock) {
  const listed = data.recent.filter((issue) => issue.listingDate);
  let board = 'All';
  let query = '';
  let shown = IPO_PAGE_SIZE;
  const expanded = new Set();

  const tbody = el('tbody');
  const moreButton = el('button', { type: 'button', class: 'secondary-button', onclick: () => {
    shown += IPO_PAGE_SIZE;
    draw();
  } }, 'Show more');
  const count = el('p', { class: 'section-note' });

  function issueRows(issue) {
    const isOpen = expanded.has(issue.symbol);
    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'row-toggle',
        'aria-expanded': String(isOpen),
        onclick: () => {
          if (expanded.has(issue.symbol)) expanded.delete(issue.symbol);
          else expanded.add(issue.symbol);
          draw();
        },
      },
      el('span', { class: 'row-chevron', 'aria-hidden': 'true' }),
      el('span', { class: 'row-name' }, el('span', {}, issue.name), el('small', {}, [issue.symbol, issue.board].join(' · '))),
    );
    const rows = [
      el(
        'tr',
        { class: isOpen ? 'is-open' : null },
        el('td', {}, toggle),
        el('td', {}, formatPlainDate(issue.listingDate)),
        el('td', {}, issue.issuePrice ? formatRupees(issue.issuePrice) : '–'),
        percentCell(issue.performance?.listingGain),
        percentCell(issue.performance?.returnSinceIssue),
        el('td', {}, issue.detail?.subscribedAllExchanges ? `${formatNumber(issue.detail.subscribedAllExchanges)}×` : '–'),
      ),
    ];
    if (isOpen) rows.push(el('tr', { class: 'detail-row' }, el('td', { colspan: '6' }, issueDetail(issue, onOpenStock))));
    return rows;
  }

  function draw() {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = listed.filter(
      (issue) =>
        (board === 'All' || issue.board === board) &&
        terms.every((term) => `${issue.name} ${issue.symbol}`.toLowerCase().includes(term)),
    );
    count.textContent = `${formatNumber(matching.length, 'INR', 0)} ${matching.length === 1 ? 'IPO' : 'IPOs'} in the last 12 months`;
    tbody.replaceChildren(
      ...(matching.length
        ? matching.slice(0, shown).flatMap(issueRows)
        : [el('tr', {}, el('td', { colspan: '6', class: 'empty-cell' }, 'No IPOs match. Try another name or board.'))]),
    );
    moreButton.hidden = shown >= matching.length;
  }

  const search = el('input', {
    type: 'search',
    id: 'ipo-search',
    'aria-label': 'Search recent IPOs by name',
    placeholder: 'Search by company name',
    oninput: (event) => {
      query = event.target.value;
      shown = IPO_PAGE_SIZE;
      draw();
    },
  });

  draw();
  return el(
    'div',
    { class: 'ipo-tab' },
    el(
      'div',
      { class: 'ipo-tools' },
      search,
      segmented({
        label: 'Filter by board',
        options: ['All', 'Main board', 'SME'].map((value) => ({ value, label: value })),
        chosen: board,
        onChoose: (value) => {
          board = value;
          shown = IPO_PAGE_SIZE;
          draw();
        },
      }),
      count,
    ),
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        { class: 'ipo-table' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            ...['Company', 'Listed', 'Issue price', 'Listing gain', 'Since issue', 'Subscribed'].map((heading) => el('th', { scope: 'col' }, heading)),
          ),
        ),
        tbody,
      ),
    ),
    moreButton,
    el('p', { class: 'section-note' }, 'Listing gain compares the first traded price with the issue price. Since issue uses the latest close and allows for later splits. Source: NSE.'),
  );
}

function filingsTab(data) {
  return el(
    'div',
    { class: 'ipo-tab two-columns' },
    el(
      'section',
      {},
      sectionHead('Final prospectus filed', 'Red herring prospectus. Source: SEBI'),
      el('ul', { class: 'feed' }, ...data.rhpFiled.map(filingRow)),
      el('p', { class: 'links' }, externalLink('https://www.sebi.gov.in/filings/public-issues.html', 'All SEBI filings ↗')),
    ),
    el(
      'section',
      {},
      sectionHead('Draft filed, in the pipeline', 'DRHP and similar. Source: SEBI'),
      el('ul', { class: 'feed' }, ...data.draftsFiled.map(filingRow)),
    ),
  );
}

function ipoNewsTab(data) {
  const news = data.news ?? [];
  return el(
    'div',
    { class: 'ipo-tab' },
    sectionHead('IPO news', `Collected on ${formatPlainDate(data.asOf)}, from established publishers`),
    news.length
      ? el(
          'ul',
          { class: 'feed' },
          ...news.map((story) => el('li', {}, el('p', { class: 'feed-title' }, externalLink(story.url, story.title)), el('p', { class: 'feed-meta' }, `${story.publisher}, ${formatPlainDate(story.date)}`))),
        )
      : el('p', { class: 'empty' }, 'No recent IPO headlines from the publishers this page trusts.'),
    el('p', { class: 'links' }, externalLink('https://news.google.com/search?q=IPO%20India&hl=en-IN&gl=IN&ceid=IN:en', 'Latest IPO news ↗')),
  );
}

function ipoGuideTab() {
  return el(
    'div',
    { class: 'ipo-tab' },
    el(
      'section',
      {},
      sectionHead('How an IPO works', 'From filing to listing'),
      el('ol', { class: 'timeline' }, ...IPO_STEPS.map(([title, text]) => el('li', {}, el('p', { class: 'feed-title' }, title), el('p', { class: 'feed-meta' }, text)))),
    ),
    el(
      'section',
      {},
      sectionHead('Terms you’ll see'),
      el('dl', { class: 'terms' }, ...IPO_TERMS.map(([term, meaning]) => el('div', {}, el('dt', {}, term), el('dd', {}, meaning)))),
    ),
    el(
      'section',
      {},
      sectionHead('Check your allotment', 'Use the registrar named in the IPO’s details'),
      el('ul', { class: 'doc-links' }, ...ALLOTMENT_LINKS.map(([name, url]) => el('li', {}, externalLink(url, `${name} ↗`)))),
    ),
    el(
      'p',
      { class: 'section-note' },
      'This is a general guide, and SEBI’s rules can change. The prospectus is the final word on any IPO. This page doesn’t show grey market premium, which is unofficial and unregulated.',
    ),
  );
}

function renderIpoView(host, data, onOpenStock) {
  const { mainBoard, sme } = data.summary;
  const tabs = {
    live: () => openAndUpcomingTab(data, onOpenStock),
    listed: () => recentlyListedTab(data, onOpenStock),
    filings: () => filingsTab(data),
    news: () => ipoNewsTab(data),
    guide: () => ipoGuideTab(),
  };
  const panel = el('div', { class: 'ipo-panel' });
  const choose = (name) => transition(() => panel.replaceChildren(tabs[name]()));
  panel.append(tabs.live());

  const gainText = (summary) => (summary.priced ? `${formatSigned(summary.medianGain)}%` : null);
  host.replaceChildren(
    el(
      'div',
      { class: 'ipo-view reveal' },
      el(
        'header',
        { class: 'ipo-hero' },
        el(
          'div',
          {},
          el('h1', {}, 'IPOs'),
          el('p', { class: 'ipo-intro' }, `Open and upcoming issues, recent listings and how they performed, from NSE and SEBI records. As of ${formatPlainDate(data.asOf)}.`),
        ),
        statGroup(
          'on-hero',
          stat('Main-board IPOs, last 12 months', formatNumber(mainBoard.count, 'INR', 0)),
          stat('Their median listing gain', gainText(mainBoard)),
          mainBoard.priced ? stat('Listed above issue price', `${mainBoard.positiveShare}%`) : null,
          stat('SME IPOs, last 12 months', formatNumber(sme.count, 'INR', 0)),
        ),
      ),
      segmented({
        label: 'IPO sections',
        options: [
          { value: 'live', label: 'Open and upcoming' },
          { value: 'listed', label: 'Recently listed' },
          { value: 'filings', label: 'SEBI filings' },
          { value: 'news', label: 'News' },
          { value: 'guide', label: 'Guide' },
        ],
        chosen: 'live',
        onChoose: choose,
      }),
      panel,
    ),
  );
}
