// ─── State ────────────────────────────────────────────────────────────────────
const AUTO_REFRESH_MS = 10 * 60 * 1000;
let isRefreshing    = false;
let allEvents       = [];
let lastEventIds    = new Set();
let activeCategories = new Set();
let activeSources    = new Set();
let breakingDismissedId = null;  // id of the event the user dismissed

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'Asia/Shanghai'
    });
  } catch { return dateStr; }
}

function getDateLabel(dateStr) {
  const d   = new Date(dateStr);
  const now  = new Date();
  const toDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff  = toDay(now) - toDay(d);
  if (diff === 0)         return '今天';
  if (diff === 86400000)  return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

// ─── Breaking News Banner ─────────────────────────────────────────────────────
function updateBreakingBanner(events) {
  const breaking = events
    .filter(e => (e.importance || 0) >= 5)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))[0];

  const banner = document.getElementById('breaking-banner');
  if (!breaking) { banner.style.display = 'none'; return; }
  // Don't re-show if user dismissed this exact event
  if (breaking.id === breakingDismissedId) return;

  const titleZh = (breaking.titleZh && breaking.titleZh !== breaking.titleEn)
    ? breaking.titleZh : breaking.titleEn;
  document.getElementById('breaking-text').textContent = titleZh;

  const link = document.getElementById('breaking-link');
  if (breaking.link) { link.href = breaking.link; link.style.display = ''; }
  else               { link.style.display = 'none'; }

  banner.style.display = 'flex';
}

function dismissBreaking() {
  const banner = document.getElementById('breaking-banner');
  // Record which event was dismissed so it won't pop back on auto-refresh
  const text = document.getElementById('breaking-text').textContent;
  const dismissed = allEvents.find(e =>
    (e.titleZh === text || e.titleEn === text) && e.importance >= 5
  );
  if (dismissed) breakingDismissedId = dismissed.id;
  banner.style.display = 'none';
}

// ─── Filter Bar ───────────────────────────────────────────────────────────────
const CATEGORY_ORDER = ['军事打击', '防空拦截', '人员伤亡', '外交动向', '制裁经济', '内政局势', '其他'];

function buildFilterBar(events) {
  const categories = new Set(events.map(e => e.category).filter(Boolean));
  const sources    = new Set(events.map(e => e.source).filter(Boolean));
  const bar = document.getElementById('filter-bar');
  bar.innerHTML = '';

  if (categories.size) {
    const lbl = document.createElement('span');
    lbl.className = 'filter-label';
    lbl.textContent = '分类';
    bar.appendChild(lbl);
    CATEGORY_ORDER.filter(c => categories.has(c)).forEach(cat =>
      bar.appendChild(makeFilterChip(cat, activeCategories))
    );
  }

  if (sources.size) {
    const lbl = document.createElement('span');
    lbl.className = 'filter-label';
    lbl.textContent = '来源';
    bar.appendChild(lbl);
    Array.from(sources).forEach(src =>
      bar.appendChild(makeFilterChip(src, activeSources))
    );
  }
  updateClearButton();
}

function makeFilterChip(label, set) {
  const chip = document.createElement('button');
  chip.className = `filter-chip${set.has(label) ? ' active' : ''}`;
  chip.textContent = label;
  chip.addEventListener('click', () => {
    if (set.has(label)) set.delete(label); else set.add(label);
    chip.classList.toggle('active', set.has(label));
    updateClearButton();
    renderTimeline(getFilteredEvents());
  });
  return chip;
}

function clearFilters() {
  activeCategories.clear();
  activeSources.clear();
  buildFilterBar(allEvents);       // rebuild chips (all deactivated)
  renderTimeline(getFilteredEvents());
}

function updateClearButton() {
  const btn = document.getElementById('filter-clear');
  btn.style.display = (activeCategories.size || activeSources.size) ? '' : 'none';
}

function getFilteredEvents() {
  return allEvents.filter(e => {
    if (activeCategories.size && !activeCategories.has(e.category)) return false;
    if (activeSources.size    && !activeSources.has(e.source))      return false;
    return true;
  });
}

// ─── Cluster Grouping ─────────────────────────────────────────────────────────
function groupByClusters(events) {
  const map = new Map();
  for (const e of events) {
    const key = e.eventCluster || `solo-${e.id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  const clusters = Array.from(map.values()).map(articles => {
    articles.sort((a, b) =>
      (b.importance || 3) - (a.importance || 3) ||
      new Date(b.pubDate) - new Date(a.pubDate)
    );
    return articles;
  });
  clusters.sort((a, b) => new Date(b[0].pubDate) - new Date(a[0].pubDate));
  return clusters;
}

// ─── Card & Cluster Building ──────────────────────────────────────────────────
function importanceMark(score) {
  if (score >= 5) return '<span class="imp imp-5" title="重大突发">⚡⚡</span>';
  if (score >= 4) return '<span class="imp imp-4" title="重要事件">⚡</span>';
  return '';
}

function buildCard(event, isSecondary) {
  const titleZh  = (event.titleZh && event.titleZh !== event.titleEn) ? event.titleZh : event.titleEn;
  // Prefer LLM-generated brief, fall back to translated/English summary
  const summary  = event.briefZh || event.summaryZh || event.summaryEn || '';
  const cat      = event.category || '';

  const card = document.createElement('div');
  card.className = `event-card ${event.sourceKey || ''}${isSecondary ? ' secondary-card' : ''}`;
  card.innerHTML = `
    <div class="card-meta">
      <span class="source-tag">${escapeHtml(event.source)}</span>
      ${cat ? `<span class="category-tag" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)}</span>` : ''}
      ${importanceMark(event.importance || 3)}
      <span class="card-date">🕐 ${formatDate(event.pubDate)}</span>
    </div>
    <div class="title-zh">${escapeHtml(titleZh)}</div>
    ${titleZh !== event.titleEn ? `<div class="title-en">${escapeHtml(event.titleEn)}</div>` : ''}
    ${!isSecondary && summary ? `<div class="summary-zh">${escapeHtml(summary)}</div>` : ''}
    ${event.link ? `<a class="read-more" href="${escapeHtml(event.link)}" target="_blank" rel="noopener">查看原文 →</a>` : ''}
  `;
  return card;
}

function buildClusterBlock(articles) {
  const [primary, ...others] = articles;
  const wrapper = document.createElement('div');
  wrapper.className = 'cluster-wrapper';
  wrapper.appendChild(buildCard(primary, false));

  if (others.length > 0) {
    const btn = document.createElement('button');
    btn.className = 'more-sources-btn';
    btn.textContent = `另有 ${others.length} 个来源报道同一事件 ▾`;

    const sub = document.createElement('div');
    sub.className = 'sub-sources hidden';
    others.forEach(a => sub.appendChild(buildCard(a, true)));

    btn.addEventListener('click', () => {
      const collapsed = sub.classList.toggle('hidden');
      btn.textContent = collapsed
        ? `另有 ${others.length} 个来源报道同一事件 ▾`
        : '收起 ▴';
    });
    wrapper.appendChild(btn);
    wrapper.appendChild(sub);
  }
  return wrapper;
}

// ─── Timeline Rendering ───────────────────────────────────────────────────────
function renderTimeline(filteredEvents) {
  const timeline   = document.getElementById('timeline');
  const emptyState = document.getElementById('empty-state');

  if (!filteredEvents.length) {
    emptyState.style.display = 'block';
    emptyState.querySelector('p').textContent =
      (activeCategories.size || activeSources.size)
        ? '🔍 没有符合筛选条件的事件。'
        : '📡 暂无事件。点击「刷新新闻」获取最新报道。';
    timeline.innerHTML = '';
    renderDayNav([]);
    return;
  }

  emptyState.style.display = 'none';
  timeline.innerHTML = '';

  const clusters = groupByClusters(filteredEvents);
  let lastDateLabel = '';
  const days = [];
  let dayIndex = 0;

  clusters.forEach(cluster => {
    const label = getDateLabel(cluster[0].pubDate);
    if (label !== lastDateLabel) {
      lastDateLabel = label;
      const id = `day-divider-${dayIndex++}`;
      days.push({ label, id });
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.id = id;
      divider.textContent = label;
      timeline.appendChild(divider);
    }
    timeline.appendChild(buildClusterBlock(cluster));
  });

  renderDayNav(days);
}

// ─── Day Navigation ───────────────────────────────────────────────────────────
function renderDayNav(days) {
  const nav = document.getElementById('day-nav');
  nav.innerHTML = '';

  if (nav._scrollHandler) {
    window.removeEventListener('scroll', nav._scrollHandler);
    nav._scrollHandler = null;
  }

  if (days.length < 2) { nav.style.display = 'none'; return; }
  nav.style.display = 'flex';
  nav.style.top = document.querySelector('.header').offsetHeight + 'px';

  days.forEach(({ label, id }, i) => {
    const btn = document.createElement('button');
    btn.className = 'day-nav-btn' + (i === 0 ? ' active' : '');
    btn.textContent = label;
    btn.dataset.targetId = id;
    btn.addEventListener('click', () => {
      const target = document.getElementById(id);
      if (!target) return;
      const top = target.getBoundingClientRect().top + window.scrollY
                  - document.querySelector('.header').offsetHeight
                  - nav.offsetHeight - 8;
      window.scrollTo({ top, behavior: 'smooth' });
    });
    nav.appendChild(btn);
  });

  const buttons = Array.from(nav.querySelectorAll('.day-nav-btn'));

  const updateActive = () => {
    const threshold = document.querySelector('.header').offsetHeight + nav.offsetHeight + 20;
    let activeId = buttons[0]?.dataset.targetId;
    for (const btn of buttons) {
      const el = document.getElementById(btn.dataset.targetId);
      if (el && el.getBoundingClientRect().top <= threshold) activeId = btn.dataset.targetId;
    }
    buttons.forEach(b => {
      const isActive = b.dataset.targetId === activeId;
      b.classList.toggle('active', isActive);
      if (isActive) b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
  };

  nav._scrollHandler = updateActive;
  window.addEventListener('scroll', updateActive, { passive: true });
  updateActive();
}

function renderAll(events) {
  document.getElementById('loading-state').style.display = 'none';
  updateBreakingBanner(events);
  buildFilterBar(events);
  renderTimeline(getFilteredEvents());
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// ─── Header Utilities ─────────────────────────────────────────────────────────
function updateCount(total) {
  const el = document.getElementById('event-count');
  if (el) el.textContent = total ?? '0';
}

function updateTimestamp(isoStr) {
  const el = document.getElementById('last-updated');
  if (!el) return;
  try {
    el.textContent = `最后更新：${new Date(isoStr).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  } catch { el.textContent = `最后更新：${isoStr}`; }
}

function setRefreshing(active) {
  isRefreshing = active;
  document.getElementById('refresh-btn').disabled   = active;
  document.getElementById('refresh-icon').classList.toggle('spinning', active);
  document.getElementById('refresh-label').textContent = active ? '加载中...' : '重新加载';
}

// ─── Situation Analysis ───────────────────────────────────────────────────────
let analysisRefreshing = false;

const RISK_COLORS = ['', '#22c55e', '#84cc16', '#f59e0b', '#f97316', '#ef4444'];
const RISK_BG     = ['', 'rgba(34,197,94,0.1)', 'rgba(132,204,22,0.1)', 'rgba(245,158,11,0.1)', 'rgba(249,115,22,0.1)', 'rgba(239,68,68,0.12)'];

function renderAnalysis(data) {
  const body = document.getElementById('analysis-body');
  if (!data) {
    body.innerHTML = '<div class="analysis-empty">📭 暂无综述，请点击刷新按钮生成</div>';
    return;
  }

  const lvl   = Math.min(5, Math.max(1, data.riskLevel || 3));
  const color = RISK_COLORS[lvl];
  const bg    = RISK_BG[lvl];
  const dots  = Array.from({ length: 5 }, (_, i) =>
    `<span class="risk-dot${i < lvl ? ' active' : ''}" style="${i < lvl ? `background:${color}` : ''}"></span>`
  ).join('');

  const phasesHtml = (data.phases || []).map(p => `
    <div class="analysis-phase">
      <div class="phase-label">${escapeHtml(p.label)}</div>
      <div class="phase-range">${escapeHtml(p.dateRange || '')}</div>
      <div class="phase-summary">${escapeHtml(p.summary || '')}</div>
    </div>`).join('');

  const actorsHtml = (data.actors || []).map(a => `
    <div class="analysis-actor">
      <span class="actor-emoji">${escapeHtml(a.emoji || '🏳')}</span>
      <div>
        <div class="actor-name">${escapeHtml(a.name)}</div>
        <div class="actor-stance">${escapeHtml(a.stance || '')}</div>
      </div>
    </div>`).join('');

  const signalsHtml = (data.keySignals || []).map(s => `
    <div class="analysis-signal">
      <span class="signal-dot">●</span>
      <div>
        <span class="signal-text">${escapeHtml(s.signal || '')}</span>
        ${s.implication ? `<span class="signal-impl">— ${escapeHtml(s.implication)}</span>` : ''}
      </div>
    </div>`).join('');

  const watchHtml = (data.watchPoints || []).map(w =>
    `<span class="watch-tag">${escapeHtml(w)}</span>`
  ).join('');

  body.innerHTML = `
    <div class="analysis-card" style="border-color:${color}40; background: linear-gradient(135deg, ${bg}, transparent)">

      <div class="risk-row">
        <div class="risk-meter">
          <span class="risk-label-text">冲突烈度</span>
          <div class="risk-dots">${dots}</div>
          <span class="risk-level-label" style="color:${color}">${escapeHtml(data.riskLabel || `L${lvl}`)}</span>
        </div>
        <div class="analysis-meta-right">基于 ${data.basedOnEvents || '?'} 条事件</div>
      </div>

      <p class="analysis-overview">${escapeHtml(data.overview || '')}</p>

      ${phasesHtml ? `<div class="analysis-block-title">冲突阶段</div><div class="analysis-phases">${phasesHtml}</div>` : ''}

      ${actorsHtml ? `<div class="analysis-block-title">各方立场</div><div class="analysis-actors">${actorsHtml}</div>` : ''}

      ${signalsHtml ? `<div class="analysis-block-title">关键信号</div><div class="analysis-signals">${signalsHtml}</div>` : ''}

      ${data.trajectory ? `<div class="analysis-block-title">走向研判</div><p class="analysis-trajectory">${escapeHtml(data.trajectory)}</p>` : ''}

      ${watchHtml ? `<div class="analysis-block-title">关注变量</div><div class="analysis-watchpoints">${watchHtml}</div>` : ''}
    </div>`;

  if (data.lastUpdated) {
    try {
      const d = new Date(data.lastUpdated);
      document.getElementById('analysis-updated').textContent =
        d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
    } catch { /* ignore */ }
  }
}

async function loadAnalysis() {
  try {
    const res = await fetch('/api/analysis');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderAnalysis(await res.json());
  } catch (err) {
    console.error('[分析] 加载失败:', err);
    document.getElementById('analysis-body').innerHTML = '<div class="analysis-empty">⚠️ 加载失败</div>';
  }
}

async function refreshAnalysis() {
  if (analysisRefreshing) return;
  analysisRefreshing = true;
  const btn = document.getElementById('analysis-refresh-btn');
  btn.disabled = true;
  btn.classList.add('spinning');
  document.getElementById('analysis-body').innerHTML = '<div class="analysis-placeholder">正在加载战局综述...</div>';
  try {
    // 读取 KV 缓存（分析由 GitHub Actions 每小时自动生成）
    const res = await fetch('/api/analysis');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderAnalysis(await res.json());
  } catch (err) {
    console.error('[分析] 刷新失败:', err);
    showToast('战局综述加载失败', 'error');
    document.getElementById('analysis-body').innerHTML = '<div class="analysis-empty">⚠️ 加载失败，请重试</div>';
  } finally {
    analysisRefreshing = false;
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

// ─── Polymarket ───────────────────────────────────────────────────────────────
let polyRefreshing = false;

function formatVolume(v) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${Math.round(v / 1_000)}K`;
  return `$${v}`;
}

function formatEndDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

function buildPolyCard(market) {
  const { question, questionZh, outcomes, prices, prevPrices, volume, endDate, url } = market;
  const displayQ = (questionZh && questionZh !== question) ? questionZh : question;

  // Show up to 2 outcomes
  const count = Math.min(outcomes.length, 2);
  const barClasses = ['poly-bar-yes', 'poly-bar-no', 'poly-bar-alt'];

  const outcomesHtml = Array.from({ length: count }, (_, i) => {
    const pct     = Math.round((prices[i]     || 0) * 100);
    const prevPct = Math.round((prevPrices[i] || prices[i] || 0) * 100);
    const delta   = pct - prevPct;
    let trendHtml = '';
    if (Math.abs(delta) >= 1) {
      const dir  = delta > 0 ? 'up' : 'down';
      const sign = delta > 0 ? '▲ +' : '▼ ';
      trendHtml = `<span class="poly-trend ${dir}">${sign}${Math.abs(delta)}%</span>`;
    } else {
      trendHtml = `<span class="poly-trend flat"></span>`;
    }
    const name = String(outcomes[i] || '').slice(0, 6);
    return `
      <div class="poly-outcome-row">
        <span class="poly-outcome-name">${escapeHtml(name)}</span>
        <div class="poly-bar-wrap">
          <div class="poly-bar ${barClasses[i] || 'poly-bar-alt'}" style="width:${pct}%"></div>
        </div>
        <span class="poly-pct">${pct}%</span>
        ${trendHtml}
      </div>`;
  }).join('');

  const metaParts = [];
  if (volume > 0) metaParts.push(`💰 ${formatVolume(volume)}`);
  if (endDate)    metaParts.push(`📅 截止${formatEndDate(endDate)}`);

  const card = document.createElement('a');
  card.className = 'poly-card';
  card.href      = url;
  card.target    = '_blank';
  card.rel       = 'noopener noreferrer';
  card.innerHTML = `
    <div class="poly-question">${escapeHtml(displayQ)}</div>
    <div class="poly-outcomes">${outcomesHtml}</div>
    <div class="poly-meta">
      ${metaParts.map(p => `<span>${escapeHtml(p)}</span>`).join('')}
      <a class="poly-meta-link" href="${escapeHtml(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">在 Polymarket 查看 →</a>
    </div>`;
  return card;
}

function renderPolymarket(data) {
  const grid = document.getElementById('poly-grid');
  if (!data?.markets?.length) {
    grid.innerHTML = '<div class="poly-empty">📭 暂无相关预测市场数据</div>';
    return;
  }
  grid.innerHTML = '';
  data.markets.forEach(m => grid.appendChild(buildPolyCard(m)));

  if (data.lastUpdated) {
    try {
      const d = new Date(data.lastUpdated);
      document.getElementById('poly-updated').textContent =
        d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
    } catch { /* ignore */ }
  }
}

async function loadPolymarket() {
  try {
    const res = await fetch('/api/polymarket');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderPolymarket(await res.json());
  } catch (err) {
    console.error('[Polymarket] 加载失败:', err);
    document.getElementById('poly-grid').innerHTML = '<div class="poly-error">⚠️ 加载失败</div>';
  }
}

async function refreshPolymarket() {
  if (polyRefreshing) return;
  polyRefreshing = true;
  const btn = document.getElementById('poly-refresh-btn');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    const res = await fetch('/api/polymarket/refresh');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderPolymarket(await res.json());
  } catch (err) {
    console.error('[Polymarket] 刷新失败:', err);
    showToast('Polymarket 刷新失败', 'error');
  } finally {
    polyRefreshing = false;
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

function startPolyAutoRefresh() {
  setInterval(loadPolymarket, 5 * 60 * 1000);
}

// ─── Market Prices ────────────────────────────────────────────────────────────
const priceCharts = new Map();
let pricesRefreshing = false;

function formatPrice(value, id) {
  if (value == null || isNaN(value)) return '—';
  if (id === 'btc') return '$' + Math.round(value).toLocaleString('en-US');
  if (id === 'dxy') return value.toFixed(2);
  return '$' + value.toFixed(2);
}

function buildPriceCard(asset) {
  const { id, nameZh, currentPrice, changePct, color } = asset;
  const up        = changePct >  0.05;
  const down      = changePct < -0.05;
  const cls       = up ? 'price-change-up' : down ? 'price-change-down' : 'price-change-flat';
  const arrow     = up ? '▲' : down ? '▼' : '—';
  const pct       = Math.abs(changePct || 0).toFixed(2);

  const card = document.createElement('div');
  card.className = `price-card ${id}`;
  card.innerHTML = `
    <div class="price-card-name">${escapeHtml(nameZh)}</div>
    <div class="price-card-value">${formatPrice(currentPrice, id)}</div>
    <div class="price-card-change ${cls}">${arrow} ${pct}%</div>
    <div class="price-chart-wrap"><canvas id="chart-${escapeHtml(id)}"></canvas></div>
  `;
  return card;
}

function drawSparkline(id, history, color) {
  const canvas = document.getElementById(`chart-${id}`);
  if (!canvas || !history.length) return;

  if (priceCharts.has(id)) {
    priceCharts.get(id).destroy();
    priceCharts.delete(id);
  }

  const ctx      = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 60);
  gradient.addColorStop(0, color + '55');
  gradient.addColorStop(1, color + '00');

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: history.map(() => ''),
      datasets: [{
        data: history.map(p => p.value),
        borderColor: color,
        borderWidth: 1.5,
        backgroundColor: gradient,
        fill: true,
        pointRadius: 0,
        tension: 0.3,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } }
    }
  });
  priceCharts.set(id, chart);
}

function renderPrices(data) {
  const grid = document.getElementById('prices-grid');
  if (!data?.assets?.length) {
    grid.innerHTML = '<div class="prices-error">⚠️ 暂无行情数据</div>';
    return;
  }
  grid.innerHTML = '';
  data.assets.forEach(asset => {
    grid.appendChild(buildPriceCard(asset));
    requestAnimationFrame(() => drawSparkline(asset.id, asset.history || [], asset.color));
  });
  if (data.lastUpdated) {
    try {
      const d = new Date(data.lastUpdated);
      document.getElementById('prices-updated').textContent =
        d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
    } catch { /* ignore */ }
  }
}

async function loadPrices() {
  try {
    const res = await fetch('/api/prices');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderPrices(await res.json());
  } catch (err) {
    console.error('[价格] 加载失败:', err);
    document.getElementById('prices-grid').innerHTML = '<div class="prices-error">⚠️ 加载行情失败</div>';
  }
}

async function refreshPrices() {
  if (pricesRefreshing) return;
  pricesRefreshing = true;
  const btn = document.getElementById('prices-refresh-btn');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    const res = await fetch('/api/prices/refresh');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderPrices(await res.json());
  } catch (err) {
    console.error('[价格] 刷新失败:', err);
    showToast('行情刷新失败', 'error');
  } finally {
    pricesRefreshing = false;
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

function startPricesAutoRefresh() {
  setInterval(loadPrices, 15 * 60 * 1000);
}

// ─── API Calls ────────────────────────────────────────────────────────────────
async function loadEvents() {
  try {
    const res  = await fetch('/api/events');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allEvents    = data.events || [];
    lastEventIds = new Set(allEvents.map(e => e.id));
    renderAll(allEvents);
    updateCount(data.total);
    if (data.lastUpdated) updateTimestamp(data.lastUpdated);
  } catch (err) {
    console.error('加载事件失败:', err);
    document.getElementById('loading-state').style.display = 'none';
    const empty = document.getElementById('empty-state');
    empty.style.display = 'block';
    empty.querySelector('p').textContent = '⚠️ 加载失败，请点击「刷新新闻」重试。';
  }
}

async function refreshEvents(isAuto = false) {
  if (isRefreshing) return;
  setRefreshing(true);
  try {
    // 读取 KV 缓存（数据由 GitHub Actions 每小时更新）
    const res  = await fetch('/api/events');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const incoming = data.events || [];

    // 检测是否有新事件（GitHub Actions 可能刚写入了新数据）
    const newCount = incoming.filter(e => !lastEventIds.has(e.id)).length;

    allEvents    = incoming;
    lastEventIds = new Set(allEvents.map(e => e.id));
    renderAll(allEvents);
    updateCount(data.total);
    if (data.lastUpdated) updateTimestamp(data.lastUpdated);

    if (isAuto && newCount > 0) showToast(`已新增 ${newCount} 条事件 ↑`, 'success');
  } catch (err) {
    console.error('刷新失败:', err);
    if (isAuto) showToast('自动刷新失败', 'error');
    else        alert('刷新失败：' + err.message);
  } finally {
    setRefreshing(false);
  }
}

function manualRefresh() { refreshEvents(false); }

function startAutoRefresh() {
  setInterval(() => refreshEvents(true), AUTO_REFRESH_MS);
}

document.addEventListener('DOMContentLoaded', () => {
  loadEvents();
  startAutoRefresh();
  loadAnalysis();
  loadPolymarket();
  startPolyAutoRefresh();
  loadPrices();
  startPricesAutoRefresh();
});
