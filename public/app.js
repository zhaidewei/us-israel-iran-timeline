// ─── Theme ────────────────────────────────────────────────────────────────────
function toggleTheme() {
  const isLight = document.documentElement.classList.toggle('light');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = isLight ? '☀️' : '🌙';
}

(function initTheme() {
  const isLight = document.documentElement.classList.contains('light');
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = isLight ? '☀️' : '🌙';
})();

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

function normalizeLink(link) {
  if (!link) return '';
  try {
    const u = new URL(String(link));
    // Ignore tracking params to dedupe same article URL variants.
    u.searchParams.delete('at_medium');
    u.searchParams.delete('at_campaign');
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    u.searchParams.sort();
    return u.toString();
  } catch {
    return String(link).trim();
  }
}

function eventQualityScore(e) {
  let score = 0;
  if (e.eventCluster) score += 4;
  if (e.category) score += 3;
  if (e.briefZh) score += 2;
  if (e.summaryZh) score += 2;
  if (e.importance != null) score += 1;
  if (e.titleZh && e.titleZh !== e.titleEn) score += 1;
  return score;
}

function dedupeEvents(events) {
  const map = new Map();
  for (const e of events) {
    const linkKey = normalizeLink(e.link);
    const fallback = `${e.source || ''}|${e.titleEn || ''}|${e.pubDate || ''}`;
    const key = linkKey ? `${e.source || ''}|${linkKey}` : fallback;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, e);
      continue;
    }

    const prevScore = eventQualityScore(prev);
    const currScore = eventQualityScore(e);
    if (currScore > prevScore) {
      map.set(key, e);
    } else if (currScore === prevScore) {
      // Tie-breaker: keep newer fetched record if available.
      const prevTs = Date.parse(prev.fetchedAt || prev.pubDate || 0);
      const currTs = Date.parse(e.fetchedAt || e.pubDate || 0);
      if (currTs > prevTs) map.set(key, e);
    }
  }
  return Array.from(map.values());
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return dateStr; }
}

function displaySourceName(source) {
  if (source === 'Press TV') return 'Press TV（伊朗英语新闻台）';
  if (source === 'NPR') return '美国全国公共广播电台';
  if (source === 'NYT') return '纽约时报';
  if (source === 'TASS') return '塔斯社';
  return source;
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
const BREAKING_WINDOW_MS = 8 * 60 * 60 * 1000; // 8 小时内算"突发"

function updateBreakingBanner(events) {
  const top5 = events
    .filter(e => (e.importance || 0) >= 5)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))[0];

  const banner = document.getElementById('breaking-banner');
  if (!top5) { banner.style.display = 'none'; return; }
  if (top5.id === breakingDismissedId) return;

  const isBreaking = (Date.now() - new Date(top5.pubDate).getTime()) < BREAKING_WINDOW_MS;

  const titleZh = (top5.titleZh && top5.titleZh !== top5.titleEn)
    ? top5.titleZh : top5.titleEn;
  document.getElementById('breaking-text').textContent = titleZh;
  document.getElementById('breaking-label').textContent = isBreaking ? '⚡ 突发' : '📌 置顶';

  const link = document.getElementById('breaking-link');
  if (top5.link) { link.href = top5.link; link.style.display = ''; }
  else           { link.style.display = 'none'; }

  banner.classList.toggle('breaking-mode', isBreaking);
  banner.classList.toggle('pinned-mode',   !isBreaking);
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

// source name → CSS key mapping
const SOURCE_KEY_MAP = {
  'BBC中东': 'bbc', '半岛电视台': 'aljazeera', '以色列时报': 'toi',
  '卫报': 'guardian', '耶路撒冷邮报': 'jpost', 'France 24': 'france24',
  '中东眼': 'mee', 'Press TV': 'presstv', '纽约时报': 'nyt', 'NPR': 'npr', 'TASS': 'tass',
  '新华社': 'xinhua',
};

function buildSourceLegend(events) {
  const sources = new Set(events.map(e => e.source).filter(Boolean));
  const container = document.getElementById('source-legend');
  // keep the title span, rebuild the rest
  container.innerHTML = '<span class="legend-title">来源：</span>';

  // "全选" button
  const allBtn = document.createElement('button');
  allBtn.className = 'legend-all-btn';
  allBtn.id = 'legend-all-btn';
  allBtn.textContent = '全选';
  allBtn.onclick = () => {
    activeSources.clear();
    updateClearButton();
    renderTimeline(getFilteredEvents());
    refreshLegendState();
  };
  container.appendChild(allBtn);

  // one clickable item per source
  sources.forEach(src => {
    const key = SOURCE_KEY_MAP[src] || '';
    const btn = document.createElement('button');
    btn.className = `legend-item ${key}`;
    btn.dataset.source = src;
    btn.innerHTML = `● ${escapeHtml(displaySourceName(src))}`;
    btn.onclick = () => {
      if (activeSources.has(src)) activeSources.delete(src);
      else activeSources.add(src);
      updateClearButton();
      renderTimeline(getFilteredEvents());
      refreshLegendState();
    };
    container.appendChild(btn);
  });
  refreshLegendState();
}

function refreshLegendState() {
  const allBtn = document.getElementById('legend-all-btn');
  if (!allBtn) return;
  const anyActive = activeSources.size > 0;
  allBtn.classList.toggle('active', !anyActive);
  const legend = document.getElementById('source-legend');
  legend.classList.toggle('has-selection', anyActive);
  document.querySelectorAll('#source-legend .legend-item').forEach(btn => {
    btn.classList.toggle('active', activeSources.has(btn.dataset.source));
  });
}

function buildFilterBar(events) {
  const categories = new Set(events.map(e => e.category).filter(Boolean));
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
  buildFilterBar(allEvents);
  refreshLegendState();
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
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function toDayKey(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'unknown';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDayLabel(dayKey) {
  try {
    const d = new Date(`${dayKey}T12:00:00`);
    return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  } catch {
    return dayKey;
  }
}

function normalizeClusterKey(eventCluster = '') {
  if (!eventCluster || String(eventCluster).startsWith('solo-')) return '';
  let key = String(eventCluster).toLowerCase().trim();
  // Remove common date-like suffixes so same event across sources can merge.
  key = key
    .replace(/-(20\d{2})(0[1-9]|1[0-2])([0-2]\d|3[01])$/, '') // -yyyymmdd
    .replace(/-(0[1-9]|1[0-2])([0-2]\d|3[01])$/, '')           // -mmdd
    .replace(/-(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, ''); // -yyyy-mm-dd
  return key;
}

function tokenizeForSimilarity(text = '') {
  const s = String(text).toLowerCase();
  const latin = s.replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
  const tokens = latin.split(/\s+/).filter(t => t.length >= 2);
  const cjkOnly = s.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjkOnly.length - 1; i++) {
    tokens.push(cjkOnly.slice(i, i + 2));
  }
  return new Set(tokens);
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

function clusterRep(cluster) {
  const top = cluster[0];
  const title = (top.titleZh && top.titleZh !== top.titleEn) ? top.titleZh : top.titleEn || '';
  const summary = top.briefZh || top.summaryZh || top.summaryEn || '';
  const clusterKey = normalizeClusterKey(top.eventCluster || '');
  const clusterTokens = new Set(clusterKey.split('-').filter(t => t && t.length >= 3));
  return {
    top,
    dayKey: toDayKey(top.pubDate),
    category: top.category || '',
    tokens: tokenizeForSimilarity(`${title} ${summary}`),
    clusterTokens,
  };
}

function mergeNearClusters(clusters, aggressive = false) {
  if (!aggressive || clusters.length < 2) return clusters;

  const used = new Array(clusters.length).fill(false);
  const reps = clusters.map(clusterRep);
  const merged = [];

  for (let i = 0; i < clusters.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const bucket = [...clusters[i]];
    const base = reps[i];

    for (let j = i + 1; j < clusters.length; j++) {
      if (used[j]) continue;
      const cand = reps[j];
      if (base.dayKey !== cand.dayKey) continue;

      const textSim = jaccardSimilarity(base.tokens, cand.tokens);
      const clusterSim = jaccardSimilarity(base.clusterTokens, cand.clusterTokens);
      const sameCategory = base.category && cand.category && base.category === cand.category;
      const shouldMerge =
        clusterSim >= 0.45 ||
        (sameCategory && textSim >= 0.34) ||
        textSim >= 0.56;
      if (!shouldMerge) continue;

      used[j] = true;
      bucket.push(...clusters[j]);
    }

    bucket.sort((a, b) =>
      (b.importance || 3) - (a.importance || 3) ||
      new Date(b.pubDate) - new Date(a.pubDate)
    );
    merged.push(bucket);
  }

  merged.sort((a, b) => new Date(b[0].pubDate) - new Date(a[0].pubDate));
  return merged;
}

function groupByClusters(events, { aggressive = false } = {}) {
  const map = new Map();
  for (const e of events) {
    const dayKey = toDayKey(e.pubDate);
    const canonical = normalizeClusterKey(e.eventCluster);
    const key = canonical ? `${canonical}::${dayKey}` : `solo-${e.id}`;
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
  return mergeNearClusters(clusters, aggressive);
}

function buildArchivedDayGroups(events) {
  const dayMap = new Map();
  for (const e of events) {
    const key = toDayKey(e.pubDate);
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key).push(e);
  }

  return Array.from(dayMap.entries())
    .map(([dayKey, dayEvents]) => {
      dayEvents.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
      const clusters = groupByClusters(dayEvents);
      const biggestCluster = clusters
        .slice()
        .sort((a, b) => (b.length - a.length) || (new Date(b[0].pubDate) - new Date(a[0].pubDate)))[0];
      const top = biggestCluster?.[0];
      return {
        dayKey,
        label: formatDayLabel(dayKey),
        events: dayEvents,
        clusters,
        topTitle: top ? ((top.titleZh && top.titleZh !== top.titleEn) ? top.titleZh : top.titleEn) : '',
        topClusterSize: biggestCluster ? biggestCluster.length : 0,
      };
    })
    .sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1));
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
      <span class="source-tag">${escapeHtml(displaySourceName(event.source))}</span>
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

// ─── Timeline Rendering (paginated) ──────────────────────────────────────────
const PAGE_SIZE = 20;
const ARCHIVE_DAY_PAGE_SIZE = 4;
let currentRecentClusters = [];
let renderedRecentClusterCount = 0;
let archivedDayGroups = [];
let appendedArchivedDayKeys = new Set();
let renderedDays = [];
let dayCounter = 0;

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
    currentRecentClusters = [];
    renderedRecentClusterCount = 0;
    archivedDayGroups = [];
    appendedArchivedDayKeys = new Set();
    renderedDays = [];
    dayCounter = 0;
    renderDayNav([]);
    return;
  }

  emptyState.style.display = 'none';
  timeline.innerHTML = '';
  const cutoffTs = Date.now() - RECENT_WINDOW_MS;
  const recentEvents = filteredEvents.filter(e => new Date(e.pubDate).getTime() >= cutoffTs);
  const olderEvents = filteredEvents.filter(e => new Date(e.pubDate).getTime() < cutoffTs);

  currentRecentClusters = groupByClusters(recentEvents, { aggressive: true });
  renderedRecentClusterCount = 0;
  archivedDayGroups = buildArchivedDayGroups(olderEvents);
  appendedArchivedDayKeys = new Set();
  renderedDays = [];
  dayCounter = 0;

  if (!recentEvents.length && archivedDayGroups.length) {
    appendArchivedSummariesBatch();
    return;
  }

  appendMoreClusters();
}

function appendMoreClusters() {
  const batch = currentRecentClusters.slice(renderedRecentClusterCount, renderedRecentClusterCount + PAGE_SIZE);
  let lastDayKey = renderedDays.length ? renderedDays[renderedDays.length - 1].dayKey : '';
  const timeline = document.getElementById('timeline');
  const appendRecentNode = (node) => {
    const archivedWrap = document.getElementById('archived-days-wrap');
    if (archivedWrap) timeline.insertBefore(node, archivedWrap);
    else timeline.appendChild(node);
  };

  batch.forEach(cluster => {
    const dayKey = toDayKey(cluster[0].pubDate);
    const label = getDateLabel(cluster[0].pubDate);
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      const id = `day-divider-${dayCounter++}`;
      renderedDays.push({ label, id, dayKey });
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.id = id;
      divider.textContent = label;
      appendRecentNode(divider);
    }
    appendRecentNode(buildClusterBlock(cluster));
  });

  renderedRecentClusterCount += batch.length;
  appendArchivedSummariesForRenderedDays();
  renderDayNav(renderedDays);
  renderLoadMoreButton();
}

function appendArchivedSummariesBatch() {
  const pending = archivedDayGroups.filter(g => !appendedArchivedDayKeys.has(g.dayKey));
  if (!pending.length) {
    renderLoadMoreButton();
    return;
  }
  const wrap = ensureArchivedWrap();

  const batch = pending.slice(0, ARCHIVE_DAY_PAGE_SIZE);
  let lastDayKey = renderedDays.length ? renderedDays[renderedDays.length - 1].dayKey : '';

  batch.forEach(group => {
    if (group.dayKey !== lastDayKey) {
      lastDayKey = group.dayKey;
      const id = `day-divider-${dayCounter++}`;
      renderedDays.push({ label: group.label, id, dayKey: group.dayKey });
      const divider = document.createElement('div');
      divider.className = 'date-divider archive-divider';
      divider.id = id;
      divider.textContent = `${group.label}（历史）`;
      wrap.appendChild(divider);
    }
    wrap.appendChild(buildArchiveDaySection(group));
    appendedArchivedDayKeys.add(group.dayKey);
  });

  renderDayNav(renderedDays);
  renderLoadMoreButton();
}

function renderLoadMoreButton() {
  const timeline = document.getElementById('timeline');
  document.getElementById('load-more-btn')?.remove();

  const remainingRecent = currentRecentClusters.length - renderedRecentClusterCount;
  const remainingArchiveDays = archivedDayGroups.filter(g => !appendedArchivedDayKeys.has(g.dayKey)).length;
  if (remainingRecent <= 0 && remainingArchiveDays <= 0) return;

  const btn = document.createElement('button');
  btn.id = 'load-more-btn';
  btn.className = 'load-more-btn';

  if (remainingRecent > 0) {
    btn.textContent = `加载更多（还有 ${remainingRecent} 个事件簇）`;
    btn.addEventListener('click', appendMoreClusters);
  } else {
    btn.textContent = `加载更多历史摘要（还有 ${remainingArchiveDays} 天）`;
    btn.addEventListener('click', appendArchivedSummariesBatch);
  }

  const archivedWrap = document.getElementById('archived-days-wrap');
  if (archivedWrap) timeline.insertBefore(btn, archivedWrap);
  else timeline.appendChild(btn);
}

function ensureArchivedWrap() {
  const timeline = document.getElementById('timeline');
  let wrap = document.getElementById('archived-days-wrap');
  if (wrap) return wrap;
  wrap = document.createElement('div');
  wrap.id = 'archived-days-wrap';
  wrap.className = 'archived-days-wrap';
  timeline.appendChild(wrap);
  return wrap;
}

function buildArchiveDaySection(group) {
  const section = document.createElement('section');
  section.className = 'archive-day-section';

  const btn = document.createElement('button');
  btn.className = 'archive-day-toggle';
  const clusterCount = group.clusters.length;
  const shortTop = group.topTitle && group.topTitle.length > 28
    ? `${group.topTitle.slice(0, 28)}...`
    : group.topTitle;
  const topTitle = shortTop ? ` · 聚合最多：${shortTop}（${group.topClusterSize}条）` : '';
  btn.textContent = `📦 ${group.label} · ${group.events.length} 条报道，${clusterCount} 个事件簇${topTitle} ▾`;

  const content = document.createElement('div');
  content.className = 'archive-day-content hidden';

  btn.addEventListener('click', () => {
    const collapsed = content.classList.toggle('hidden');
    if (!content.dataset.rendered) {
      group.clusters.forEach(cluster => content.appendChild(buildClusterBlock(cluster)));
      content.dataset.rendered = '1';
    }
    btn.textContent = collapsed
      ? `📦 ${group.label} · ${group.events.length} 条报道，${clusterCount} 个事件簇${topTitle} ▾`
      : `收起 ${group.label} 新闻 ▴`;
  });

  section.appendChild(btn);
  section.appendChild(content);
  return section;
}

function appendArchivedSummariesForRenderedDays() {
  if (!archivedDayGroups.length) return;
  const renderedDayKeys = new Set(renderedDays.map(d => d.dayKey));
  const visiblePending = archivedDayGroups.filter(g =>
    renderedDayKeys.has(g.dayKey) && !appendedArchivedDayKeys.has(g.dayKey)
  );
  if (!visiblePending.length) return;
  const wrap = ensureArchivedWrap();
  visiblePending.forEach(group => {
    wrap.appendChild(buildArchiveDaySection(group));
    appendedArchivedDayKeys.add(group.dayKey);
  });
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

  days.forEach(({ label, id }, i) => {
    const btn = document.createElement('button');
    btn.className = 'day-nav-btn' + (i === 0 ? ' active' : '');
    btn.textContent = label;
    btn.dataset.targetId = id;
    btn.addEventListener('click', () => {
      const target = document.getElementById(id);
      if (!target) return;
      const top = target.getBoundingClientRect().top + window.scrollY
                  - nav.offsetHeight - 8;
      window.scrollTo({ top, behavior: 'smooth' });
    });
    nav.appendChild(btn);
  });

  const buttons = Array.from(nav.querySelectorAll('.day-nav-btn'));

  const updateActive = () => {
    const threshold = nav.offsetHeight + 20;
    let activeId = buttons[0]?.dataset.targetId;
    for (const btn of buttons) {
      const el = document.getElementById(btn.dataset.targetId);
      if (el && el.getBoundingClientRect().top <= threshold) activeId = btn.dataset.targetId;
    }
    buttons.forEach(b => {
      const isActive = b.dataset.targetId === activeId;
      b.classList.toggle('active', isActive);
      if (isActive) {
        // 仅在 nav 内水平滚动，不触发页面垂直滚动
        const target = Math.max(0, b.offsetLeft - (nav.clientWidth - b.offsetWidth) / 2);
        nav.scrollLeft = target;
      }
    });
  };

  nav._scrollHandler = updateActive;
  window.addEventListener('scroll', updateActive, { passive: true });
  updateActive();
}

function renderAll(events) {
  document.getElementById('loading-state').style.display = 'none';
  updateBreakingBanner(events);
  buildSourceLegend(events);
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
    el.textContent = `最后更新：${new Date(isoStr).toLocaleString('zh-CN')}`;
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
        d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
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
    // 只读取缓存（避免网页端触发 DeepSeek 计费）
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
        d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
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
    // 非 token 刷新（后端已禁用 DeepL）
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
        d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
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
    const incoming = Array.isArray(data) ? data : (data.events || []);
    allEvents    = dedupeEvents(incoming);
    lastEventIds = new Set(allEvents.map(e => e.id));
    renderAll(allEvents);
    updateCount(allEvents.length);
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
    const incomingRaw = Array.isArray(data) ? data : (data.events || []);
    const incoming = dedupeEvents(incomingRaw);

    // 检测是否有新事件（GitHub Actions 可能刚写入了新数据）
    const newCount = incoming.filter(e => !lastEventIds.has(e.id)).length;

    allEvents    = incoming;
    lastEventIds = new Set(allEvents.map(e => e.id));
    renderAll(allEvents);
    updateCount(allEvents.length);
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

// ── Donate Choice Modal ──
function openDonateModal() {
  const overlay = document.getElementById('donate-overlay');
  if (!overlay) return;
  overlay.classList.add('open');
}
function closeDonateModal(e) {
  const overlay = document.getElementById('donate-overlay');
  if (!overlay) return;
  if (e && e.target !== overlay) return;
  overlay.classList.remove('open');
}
function openWechatFromDonate() {
  closeDonateModal();
  openWechatPreview();
}

// ── WeChat QR Preview ──
function openWechatPreview() {
  const overlay = document.getElementById('qr-preview-overlay');
  if (!overlay) return;
  overlay.classList.add('open');
}
function closeWechatPreview(e) {
  const overlay = document.getElementById('qr-preview-overlay');
  if (!overlay) return;
  if (e && e.target !== overlay) return;
  overlay.classList.remove('open');
}
