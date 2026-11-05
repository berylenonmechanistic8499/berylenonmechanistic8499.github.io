# Pivot Calculator

Pick a stock or index and a trading day to get its pivot point, with a price chart, fundamentals and news.

```
Pivot = (Open + High + Close) / 3
```

## Automatic updates

GitHub rebuilds and publishes the page twice a day, using `.github/workflows/update.yml`:

- 21:15 India time, after NSE publishes the day's reports.
- 07:45 India time, after US markets close.

To update it straight away, open the project's **Actions** tab on GitHub, choose **Update the site**, then **Run workflow**.

If an update fails, the live page stays as it was and GitHub emails you. When one source fails, its instruments keep their earlier data while the rest update. If updates stop for more than six days, the page says so at the top. To see which sources GitHub can currently reach, and test a complete build without publishing it, run the **Check data sources** workflow.

## Build it on your own computer

With [Node.js](https://nodejs.org) 18 or newer:

```
npm run build
```

Then double-click `dist/index.html`. Downloads are kept in `.cache/`, so a rebuild only fetches what's new. To rebuild the page without collecting data again, run `npm run assemble`.

## Where the data comes from

| Data | Source |
|---|---|
| NSE stock and index prices, delivery, P/E, P/B, dividend yield | NSE's daily reports |
| Market cap, shares issued, filings, board meetings, ex-dates | NSE's daily bundle |
| SENSEX, S&P 500, NASDAQ, Dow | Yahoo Finance, because no official source for these is usable (BSE's refuses automated requests, and Nasdaq's own feed has wrong opens on about 25 of 750 days) |
| Company financials | Yahoo Finance |
| News | Google News, filtered to the publishers listed in `scripts/sources/news.js` |

The page names its source beside each set of figures.

## How it works

- `scripts/collect.js` gathers everything into `.cache/dataset.json`, using the readers in `scripts/sources/`.
- `scripts/dataset-checks.js` refuses an update that would damage the page.
- `scripts/assemble.js` joins that dataset and the code in `page/` and `lib/` into the two files in `dist/`: `index.html` is the live site, and `pivot-calculator.html` is the fixed copy hosted as a Claude artifact.
- `lib/pivot.js` holds the formula.
- `lib/market.js` answers the page's questions, such as a day's pivot or the 52-week range.

## About the prices

- NSE prices are the ones actually traded on the day, so they aren't adjusted for later splits or bonuses. The page says when a later corporate action makes an old price look out of line with today's.
- The chart rescales candles across a corporate action to stay continuous. The sessions table always shows actual prices.
- Only finished trading days are included.
- Rows no market could produce, such as an open above the day's high, are dropped. So are Yahoo's flat bars, which repeat the last close as all four prices. The page then says the day has no prices rather than show a wrong pivot.
- Corporate actions are detected from overnight falls of more than 25%, which every build logs for review. A smaller one, such as ITC's January 2025 demerger, appears as an ordinary price move.

## Test it

```
npm test
```
