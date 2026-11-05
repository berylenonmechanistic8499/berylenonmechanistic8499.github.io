// Candlesticks drawn to scale with a single pivot level. The sessions table beside it holds the same values.
const SVG_NS = 'http://www.w3.org/2000/svg';
const MARGIN = { top: 12, right: 78, bottom: 26, left: 4 };
const NARROW_WIDTH = 560;
const NARROW_BEFORE = 24;
const NARROW_AFTER = 8;
const TICK_COUNT = 5;
const MIN_LABEL_GAP = 46;
const MAX_BODY_WIDTH = 14;

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

function niceTicks(min, max) {
  const rough = (max - min) / TICK_COUNT;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough);
  const ticks = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { ticks, decimals: decimalsFor(step) };
}

// Enough decimals to keep neighbouring ticks distinct on a low-priced stock, and no more.
function decimalsFor(step) {
  for (let decimals = 0; decimals < 4; decimals++) {
    const scaled = step * 10 ** decimals;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return decimals;
  }
  return 4;
}

export function renderChart(host, { bars: allBars, selectedIndex, pivot, formatPrice, formatAxis, formatDate, formatShortDate, onSelect }) {
  const width = host.clientWidth;
  if (!width) return;
  const narrow = width < NARROW_WIDTH;
  const height = Math.max(narrow ? 280 : 340, host.clientHeight);

  const first = narrow ? Math.max(0, selectedIndex - NARROW_BEFORE) : 0;
  const last = narrow ? Math.min(allBars.length - 1, selectedIndex + NARROW_AFTER) : allBars.length - 1;
  const bars = allBars.slice(first, last + 1);
  const selected = selectedIndex - first;

  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const step = plotWidth / bars.length;
  const bodyWidth = Math.max(3, Math.min(MAX_BODY_WIDTH, step * 0.62));

  const lows = bars.map((bar) => bar.chartLow);
  const highs = bars.map((bar) => bar.chartHigh);
  const rawMin = Math.min(...lows, pivot);
  const rawMax = Math.max(...highs, pivot);
  const padding = (rawMax - rawMin || rawMax * 0.01 || 1) * 0.06;
  const yMin = rawMin - padding;
  const yMax = rawMax + padding;

  const x = (index) => MARGIN.left + step * (index + 0.5);
  const y = (price) => MARGIN.top + ((yMax - price) / (yMax - yMin)) * plotHeight;
  const pivotY = y(pivot);

  const chart = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    height,
    role: 'img',
    'aria-label': `Candlestick chart of ${bars.length} sessions from ${formatDate(bars[0].date)} to ${formatDate(bars.at(-1).date)}, with the pivot level of ${formatPrice(pivot)}. The sessions table lists the same values.`,
  });

  chart.append(svgEl('rect', { x: MARGIN.left + step * selected, y: MARGIN.top, width: step, height: plotHeight, fill: 'var(--band)', rx: 2 }));

  const { ticks, decimals } = niceTicks(yMin, yMax);
  for (const tick of ticks) {
    const tickY = y(tick);
    chart.append(svgEl('line', { x1: MARGIN.left, x2: width - MARGIN.right, y1: tickY, y2: tickY, stroke: 'var(--grid)', 'stroke-width': 1 }));
    if (Math.abs(tickY - pivotY) > 15) {
      const label = svgEl('text', { x: width - MARGIN.right + 8, y: tickY + 4, class: 'axis-label' });
      label.textContent = formatAxis(tick, decimals);
      chart.append(label);
    }
  }

  chart.append(svgEl('line', { x1: MARGIN.left, x2: width - MARGIN.right, y1: pivotY, y2: pivotY, stroke: 'var(--pivot)', 'stroke-width': 2 }));

  bars.forEach((bar, index) => {
    const isUp = bar.chartClose >= bar.chartOpen;
    const color = isUp ? 'var(--up)' : 'var(--down)';
    const top = y(Math.max(bar.chartOpen, bar.chartClose));
    const bottom = y(Math.min(bar.chartOpen, bar.chartClose));
    chart.append(
      svgEl('line', { x1: x(index), x2: x(index), y1: y(bar.chartHigh), y2: y(bar.chartLow), stroke: color, 'stroke-width': 1.25 }),
      // Hollow against solid means direction never depends on telling the two colours apart.
      svgEl('rect', {
        x: x(index) - bodyWidth / 2,
        y: top,
        width: bodyWidth,
        height: Math.max(1.5, bottom - top),
        rx: 1,
        fill: isUp ? (index === selected ? 'var(--band)' : 'var(--surface)') : color,
        stroke: color,
        'stroke-width': 1.25,
      }),
    );
  });

  const selectedLabelX = x(selected);
  let lastLabelX = -Infinity;
  bars.forEach((bar, index) => {
    const isNewMonth = index > 0 && bar.date.slice(0, 7) !== bars[index - 1].date.slice(0, 7);
    const labelX = x(index);
    if (!isNewMonth || labelX - lastLabelX < MIN_LABEL_GAP || Math.abs(labelX - selectedLabelX) < MIN_LABEL_GAP) return;
    const label = svgEl('text', { x: labelX, y: height - 8, 'text-anchor': 'middle', class: 'axis-label' });
    label.textContent = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(new Date(`${bar.date}T00:00:00Z`));
    chart.append(label);
    lastLabelX = labelX;
  });
  const selectedLabel = svgEl('text', {
    x: Math.min(Math.max(selectedLabelX, 22), width - MARGIN.right - 22),
    y: height - 8,
    'text-anchor': 'middle',
    class: 'axis-label is-selected',
  });
  selectedLabel.textContent = formatShortDate(bars[selected].date);
  chart.append(selectedLabel);

  const pillWidth = MARGIN.right - 2;
  chart.append(
    svgEl('rect', { x: width - MARGIN.right + 2, y: pivotY - 10, width: pillWidth, height: 20, rx: 4, fill: 'var(--pivot)' }),
  );
  const pivotLabel = svgEl('text', {
    x: width - MARGIN.right + 2 + pillWidth / 2,
    y: pivotY + 4,
    'text-anchor': 'middle',
    fill: 'var(--on-pivot)',
    'font-size': 11,
    'font-weight': 600,
    'font-variant-numeric': 'tabular-nums',
  });
  // The pivot is the page's answer, so its label is never rounded.
  pivotLabel.textContent = formatPrice(pivot);
  chart.append(pivotLabel);

  const crosshair = svgEl('line', { y1: MARGIN.top, y2: MARGIN.top + plotHeight, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden' });
  chart.append(crosshair);

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  let active = selected;

  function show(index) {
    active = index;
    const bar = bars[index];
    crosshair.setAttribute('x1', x(index));
    crosshair.setAttribute('x2', x(index));
    crosshair.setAttribute('visibility', 'visible');

    const dateLine = document.createElement('div');
    dateLine.className = 'tip-date';
    dateLine.textContent = formatDate(bar.date);
    const rows = [
      ['Open', bar.open],
      ['High', bar.high],
      ['Low', bar.low],
      ['Close', bar.close],
      ['Pivot', bar.pivot],
    ].map(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const strong = document.createElement('strong');
      strong.textContent = formatPrice(value);
      row.append(label, strong);
      return row;
    });
    tip.replaceChildren(dateLine, ...rows);
    tip.hidden = false;

    const tipWidth = tip.offsetWidth;
    const preferred = x(index) + 12;
    tip.style.left = `${preferred + tipWidth > width ? Math.max(0, x(index) - tipWidth - 12) : preferred}px`;
    tip.style.top = `${MARGIN.top + 4}px`;
  }

  function hide() {
    tip.hidden = true;
    crosshair.setAttribute('visibility', 'hidden');
  }

  const indexAt = (clientX) => {
    const offset = clientX - chart.getBoundingClientRect().left - MARGIN.left;
    return Math.min(bars.length - 1, Math.max(0, Math.floor(offset / step)));
  };

  chart.addEventListener('pointermove', (event) => show(indexAt(event.clientX)));
  chart.addEventListener('pointerleave', hide);
  chart.addEventListener('click', (event) => onSelect(bars[indexAt(event.clientX)].date));

  host.onkeydown = (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      show(Math.min(bars.length - 1, Math.max(0, active + (event.key === 'ArrowRight' ? 1 : -1))));
    } else if (event.key === 'Enter') {
      onSelect(bars[active].date);
    } else if (event.key === 'Escape') {
      hide();
    }
  };
  host.onfocus = () => show(active);
  host.onblur = hide;

  host.replaceChildren(chart, tip);
}
