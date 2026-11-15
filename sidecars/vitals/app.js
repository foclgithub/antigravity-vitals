(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const POLL_MS = 1000;
  const STOPWATCH_MS = 200;
  const FIVE_HOURS_MS = 5 * 3600 * 1000;
  const RING_RADIUS = 16;
  const RING_CIRC = 2 * Math.PI * RING_RADIUS;

  const I18N = {
    zh: {
      title: 'Antigravity Vitals',
      autoTheme: '自动',
      lightTheme: '浅色',
      darkTheme: '深色',
      langBtn: 'EN',
      convLabel: '会话',
      autoConv: '自动跟随当前窗口',
      limitLabel: '上限',
      autoLimit: '自动识别',
      speedTitle: '实时吞吐与延迟',
      contextTitle: '上下文容量跑道',
      cacheTitle: '缓存效率与思考占比',
      modelHubTitle: '分模型速度与消耗',
      scopeConv: '当前会话',
      scope5h: '过去 5h',
      scopeToday: '今日累计',
      chartTitle: '单步输出速度趋势 (最近 14 步)',
      tableTitle: '最近步骤遥测明细',
      aggTitle: '本地 5 小时窗口与今日全局汇总',
      verifiedTag: '✓ SQLite + JSONL 实测',
      stateIdle: '空闲',
      stateGenerating: '生成中',
      stateTool: '工具运行中',
      stateError: '异常',
      noSpeed: '暂无测速',
      streamSpeed: '流式峰值',
      ttftLabel: '首包 TTFT',
      avgSpeed: '会话均速',
      timedSteps: '已测速步',
      segCache: '缓存',
      segInput: '新增',
      segOut: '输出',
      remain: '剩余',
      lvlOk: '充足 (<50%)',
      lvlWarn: '过半 (50%-85%)',
      lvlErr: '即将压缩 (>=85%)',
      nearCompactWarn: '上下文已达 85% 以上，即将触发自动压缩。',
      compactedPrefix: '已发生自动压缩',
      sessionCache: '整段命中',
      cacheSubDesc: 'Cache Read / Prompt',
      thinkLabel: '思考',
      textLabel: '正文',
      e2eAvg: '端到端均速',
      streamAvg: '流式',
      avgTtft: '平均首包',
      outThink: '输出 / 思考',
      totalTok: '总 Token',
      stepsWord: '步',
      shareWord: '占比',
      noModels: '当前时间范围内暂无分模型调用记录。',
      colStep: '#步',
      colModel: '模型',
      colSpeed: '速度',
      colDur: '耗时',
      colOut: '输出',
      colCtx: '上下文',
      colTools: '调用工具',
      win5hLabel: '过去 5 小时滑动窗口',
      todayLabel: '今日累计 (00:00 起)',
      win5hReset: '最早一笔滑出倒计时',
      win5hEmpty: '过去 5 小时暂无消耗',
      convsUnit: '会话',
      stepsUnit: '步',
      noData: '暂未发现本地会话日志 (transcript.jsonl)，开始对话后将自动刷新。',
      errFetch: '无法读取本地遥测接口',
    },
    en: {
      title: 'Antigravity Vitals',
      autoTheme: 'Auto',
      lightTheme: 'Light',
      darkTheme: 'Dark',
      langBtn: '中文',
      convLabel: 'Session',
      autoConv: 'Auto-follow current window',
      limitLabel: 'Budget',
      autoLimit: 'Auto',
      speedTitle: 'Throughput & Latency',
      contextTitle: 'Context Runway Capsule',
      cacheTitle: 'Cache & Thinking Split',
      modelHubTitle: 'Per-Model Breakdown',
      scopeConv: 'Session',
      scope5h: '5h Window',
      scopeToday: 'Today',
      chartTitle: 'Step Speed Blueprint (Last 14)',
      tableTitle: 'Recent Step Ledger',
      aggTitle: 'Local 5h Rolling Window & Today',
      verifiedTag: '✓ SQLite + JSONL',
      stateIdle: 'Idle',
      stateGenerating: 'Generating',
      stateTool: 'Running Tool',
      stateError: 'Error',
      noSpeed: 'No speed sample',
      streamSpeed: 'Post-TTFT',
      ttftLabel: 'TTFT',
      avgSpeed: 'Avg',
      timedSteps: 'Timed',
      segCache: 'Cache',
      segInput: 'Fresh',
      segOut: 'Out',
      remain: 'Remain',
      lvlOk: 'Healthy (<50%)',
      lvlWarn: 'Elevated (50%-85%)',
      lvlErr: 'Near Compact (>=85%)',
      nearCompactWarn: 'Context usage >= 85%; automatic compaction may trigger soon.',
      compactedPrefix: 'Compaction detected',
      sessionCache: 'Session hit',
      cacheSubDesc: 'Cache Read / Prompt',
      thinkLabel: 'Think',
      textLabel: 'Text',
      e2eAvg: 'E2E Avg',
      streamAvg: 'Stream',
      avgTtft: 'Avg TTFT',
      outThink: 'Out / Think',
      totalTok: 'Total Tokens',
      stepsWord: 'steps',
      shareWord: 'Share',
      noModels: 'No model records in the selected scope yet.',
      colStep: 'Step',
      colModel: 'Model',
      colSpeed: 'Speed',
      colDur: 'Time',
      colOut: 'Output',
      colCtx: 'Context',
      colTools: 'Tools',
      win5hLabel: 'Rolling 5h Window',
      todayLabel: 'Today Total (Since 00:00)',
      win5hReset: 'Oldest drops in',
      win5hEmpty: 'No usage in last 5h',
      convsUnit: 'sessions',
      stepsUnit: 'steps',
      noData: 'No local transcript.jsonl found yet. Start a conversation to view telemetry.',
      errFetch: 'Failed to read local vitals API',
    },
  };

  const FAMILY_FILL = {
    carbon: 'var(--m-carbon)',
    hydrogen: 'var(--m-hydrogen)',
    argon: 'var(--m-argon)',
    other: 'var(--m-other)',
  };

  function safeGetPref(key, fallback) {
    try {
      return window.localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function safeSetPref(key, val) {
    try {
      window.localStorage.setItem(key, val);
    } catch {
      // Ignore storage restriction inside sandboxed iframes
    }
  }

  function detectInitialLang() {
    const saved = safeGetPref('agy_vitals_lang', '');
    if (saved === 'zh' || saved === 'en') return saved;
    return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  const savedScope = safeGetPref('agy_vitals_scope', 'conv');
  const state = {
    lang: detectInitialLang(),
    themeOverride: safeGetPref('agy_vitals_theme', 'auto'),
    modelScope: ['conv', '5h', 'today'].includes(savedScope) ? savedScope : 'conv',
    selectedConv: '',
    contextLimit: safeGetPref('agy_vitals_limit', 'auto'),
    snapshot: null,
    lastPollClientMs: 0,
    errorMsg: '',
  };

  function t(key) {
    return (I18N[state.lang] && I18N[state.lang][key]) || I18N.en[key] || key;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svgEl(tag, attrs = {}, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, String(v));
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fmtTok(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '-';
    const val = Number(n);
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
    if (val >= 1000) return `${(val / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(Math.round(val));
  }

  function fmtDurMs(ms) {
    if (!ms || ms <= 0) return '0m';
    const mins = Math.floor(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function metricChip(label, value) {
    const chip = el('span', 'metric-chip');
    chip.appendChild(el('span', '', `${label}:`));
    chip.appendChild(el('strong', 'tabular', value));
    return chip;
  }

  function legendDot(colorClass, labelText, family) {
    const wrap = el('span', 'legend-item');
    const dot = el('span', `family-dot ${colorClass}`.trim());
    if (family) dot.dataset.family = family;
    wrap.appendChild(dot);
    wrap.appendChild(el('span', '', labelText));
    return wrap;
  }

  function detectHostTheme() {
    if (state.themeOverride === 'light' || state.themeOverride === 'dark') {
      return state.themeOverride;
    }
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f8fafc)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3) {
      const scale = c.startsWith('color(') ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return lum < 0.5 ? 'dark' : 'light';
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function syncTheme() {
    const theme = detectHostTheme();
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }

  new MutationObserver(() => syncTheme()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
  syncTheme();

  // ---------------- Persistent Cockpit DOM Skeleton ----------------
  const root = document.getElementById('app');

  // 1. Sticky Precision Topbar
  const topbar = el('header', 'topbar');
  const topLeft = el('div', 'topbar-left');

  const brandMark = el('div', 'brand-mark');
  const brandIcon = el('span', 'brand-icon');
  const brandSvg = svgEl('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none' });
  brandSvg.appendChild(
    svgEl('path', {
      d: 'M2 12h4l2.5-6 4 12 3.5-8 2 2h4',
      stroke: 'currentColor',
      'stroke-width': 2.2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );
  brandIcon.appendChild(brandSvg);
  const brandTitle = el('h1', 'brand-title');
  brandMark.appendChild(brandIcon);
  brandMark.appendChild(brandTitle);

  const activeModelPill = el('span', 'model-pill');
  const activeModelDot = el('span', 'family-dot');
  const activeModelText = el('span');
  activeModelPill.appendChild(activeModelDot);
  activeModelPill.appendChild(activeModelText);
  activeModelPill.style.display = 'none';

  const statusPill = el('span', 'status-pill');
  const statusDot = el('span', 'status-dot');
  const statusText = el('span', 'tabular');
  statusPill.appendChild(statusDot);
  statusPill.appendChild(statusText);

  topLeft.appendChild(brandMark);
  topLeft.appendChild(activeModelPill);
  topLeft.appendChild(statusPill);

  const topActions = el('div', 'topbar-actions');
  const themeSeg = el('div', 'seg-group');
  const themeButtons = new Map();
  for (const mode of ['auto', 'light', 'dark']) {
    const btn = el('button', 'seg-btn');
    btn.type = 'button';
    btn.dataset.mode = mode;
    btn.addEventListener('click', () => {
      state.themeOverride = mode;
      safeSetPref('agy_vitals_theme', mode);
      syncTheme();
      renderStaticLabels();
    });
    themeSeg.appendChild(btn);
    themeButtons.set(mode, btn);
  }
  const langBtn = el('button', 'btn-chip');
  langBtn.type = 'button';
  topActions.appendChild(themeSeg);
  topActions.appendChild(langBtn);

  topbar.appendChild(topLeft);
  topbar.appendChild(topActions);

  const content = el('div', 'content');

  // 2. Control bar
  const controlBar = el('div', 'control-bar');
  const convGroup = el('label', 'select-group');
  const convLabel = el('span', 'field-label');
  const convSelect = el('select', 'select-input');
  convGroup.appendChild(convLabel);
  convGroup.appendChild(convSelect);

  const limitGroup = el('label', 'select-group compact');
  const limitLabel = el('span', 'field-label');
  const limitSelect = el('select', 'select-input');
  const autoOpt = el('option', '', 'Auto');
  autoOpt.value = 'auto';
  limitSelect.appendChild(autoOpt);
  for (const val of [80000, 256000, 512000, 1000000]) {
    const opt = el('option', '', val === 1000000 ? '1M' : `${val / 1000}k`);
    opt.value = String(val);
    limitSelect.appendChild(opt);
  }
  limitSelect.value = state.contextLimit;
  limitGroup.appendChild(limitLabel);
  limitGroup.appendChild(limitSelect);

  controlBar.appendChild(convGroup);
  controlBar.appendChild(limitGroup);

  const emptyBanner = el('div', 'card empty-state');
  emptyBanner.style.display = 'none';

  // 3. Three Hero Bento Cards
  const metricsGrid = el('div', 'metrics-grid');

  // Card 1: Throughput & TTFT
  const speedCard = el('section', 'card card-accent');
  speedCard.dataset.accent = 'carbon';
  const speedHeader = el('div', 'card-header');
  const speedTitle = el('h2', 'card-title');
  const speedBadge = el('span', 'badge badge-neutral');
  speedHeader.appendChild(speedTitle);
  speedHeader.appendChild(speedBadge);
  const speedHero = el('div', 'hero-value tabular');
  const speedChips = el('div', 'pill-strip');
  speedCard.appendChild(speedHeader);
  speedCard.appendChild(speedHero);
  speedCard.appendChild(speedChips);

  // Card 2: Multi-Segment Context Runway
  const ctxCard = el('section', 'card card-accent');
  ctxCard.dataset.accent = 'ok';
  const ctxHeader = el('div', 'card-header');
  const ctxTitle = el('h2', 'card-title');
  const ctxBadge = el('span', 'badge badge-ok');
  ctxHeader.appendChild(ctxTitle);
  ctxHeader.appendChild(ctxBadge);
  const ctxHeroRow = el('div', 'hero-row');
  const ctxHero = el('div', 'hero-value compact tabular');
  const ctxPctPill = el('span', 'badge badge-neutral tabular');
  ctxHeroRow.appendChild(ctxHero);
  ctxHeroRow.appendChild(ctxPctPill);
  const runwayWrap = el('div', 'runway-wrap');
  const ctxTrack = el('div', 'capsule-track');
  const segCacheEl = el('div', 'capsule-seg seg-cache');
  const segInputEl = el('div', 'capsule-seg seg-input');
  const segOutEl = el('div', 'capsule-seg seg-out');
  ctxTrack.appendChild(segCacheEl);
  ctxTrack.appendChild(segInputEl);
  ctxTrack.appendChild(segOutEl);
  ctxTrack.appendChild(el('span', 'runway-tick tick-50'));
  ctxTrack.appendChild(el('span', 'runway-tick tick-85'));
  runwayWrap.appendChild(ctxTrack);
  const ctxLegend = el('div', 'legend-row tabular');
  const ctxWarn = el('div', 'alert-banner');
  ctxWarn.style.display = 'none';
  ctxCard.appendChild(ctxHeader);
  ctxCard.appendChild(ctxHeroRow);
  ctxCard.appendChild(runwayWrap);
  ctxCard.appendChild(ctxLegend);
  ctxCard.appendChild(ctxWarn);

  // Card 3: Cache Ring & Thinking Split
  const cacheCard = el('section', 'card card-accent');
  cacheCard.dataset.accent = 'hydrogen';
  const cacheHeader = el('div', 'card-header');
  const cacheTitle = el('h2', 'card-title');
  const cacheBadge = el('span', 'badge badge-neutral');
  cacheHeader.appendChild(cacheTitle);
  cacheHeader.appendChild(cacheBadge);
  const ringHero = el('div', 'ring-hero');
  const ringSvg = svgEl('svg', { class: 'ring-svg', viewBox: '0 0 42 42', 'aria-hidden': 'true' });
  ringSvg.appendChild(svgEl('circle', { class: 'ring-track', cx: 21, cy: 21, r: RING_RADIUS }));
  const ringFill = svgEl('circle', {
    class: 'ring-fill',
    cx: 21,
    cy: 21,
    r: RING_RADIUS,
    'stroke-dasharray': RING_CIRC.toFixed(2),
    'stroke-dashoffset': RING_CIRC.toFixed(2),
  });
  ringSvg.appendChild(ringFill);
  const ringMeta = el('div', 'ring-meta');
  const cacheHero = el('div', 'hero-value compact tabular');
  const cacheSubDesc = el('span', 'ring-sub');
  ringMeta.appendChild(cacheHero);
  ringMeta.appendChild(cacheSubDesc);
  ringHero.appendChild(ringSvg);
  ringHero.appendChild(ringMeta);
  const splitTrack = el('div', 'split-bar-track');
  const splitThinkBar = el('div', 'split-think');
  const splitTextBar = el('div', 'split-text');
  splitTrack.appendChild(splitThinkBar);
  splitTrack.appendChild(splitTextBar);
  const cacheLegend = el('div', 'legend-row tabular');
  cacheCard.appendChild(cacheHeader);
  cacheCard.appendChild(ringHero);
  cacheCard.appendChild(splitTrack);
  cacheCard.appendChild(cacheLegend);

  metricsGrid.appendChild(speedCard);
  metricsGrid.appendChild(ctxCard);
  metricsGrid.appendChild(cacheCard);

  // 4. Per-Model Telemetry Breakdown Card
  const modelHubCard = el('section', 'card');
  const modelHubHeader = el('div', 'card-header');
  const modelHubTitle = el('h2', 'card-title');
  const scopeSeg = el('div', 'seg-group');
  const scopeButtons = new Map();
  for (const sc of ['conv', '5h', 'today']) {
    const btn = el('button', 'seg-btn');
    btn.type = 'button';
    btn.dataset.scope = sc;
    btn.addEventListener('click', () => {
      state.modelScope = sc;
      safeSetPref('agy_vitals_scope', sc);
      render();
    });
    scopeSeg.appendChild(btn);
    scopeButtons.set(sc, btn);
  }
  modelHubHeader.appendChild(modelHubTitle);
  modelHubHeader.appendChild(scopeSeg);
  const shareBarTrack = el('div', 'share-bar-track');
  const modelListEl = el('div', 'model-list');
  modelHubCard.appendChild(modelHubHeader);
  modelHubCard.appendChild(shareBarTrack);
  modelHubCard.appendChild(modelListEl);

  // 5. Blueprint SVG Speed Chart
  const chartCard = el('section', 'card');
  const chartHeader = el('div', 'card-header');
  const chartTitle = el('h2', 'card-title');
  const chartLegend = el('div', 'legend-row');
  chartLegend.appendChild(legendDot('', 'Carbon', 'carbon'));
  chartLegend.appendChild(legendDot('', 'Hydrogen', 'hydrogen'));
  chartLegend.appendChild(legendDot('', 'Argon', 'argon'));
  chartHeader.appendChild(chartTitle);
  chartHeader.appendChild(chartLegend);
  const blueprintWrap = el('div', 'blueprint-canvas');
  const chartSvg = svgEl('svg', { class: 'speed-svg', viewBox: '0 0 620 152', role: 'img' });
  blueprintWrap.appendChild(chartSvg);
  chartCard.appendChild(chartHeader);
  chartCard.appendChild(blueprintWrap);

  // 6. Recent Steps Ledger Table
  const tableCard = el('section', 'card');
  const tableHeader = el('div', 'card-header');
  const tableTitle = el('h2', 'card-title');
  tableHeader.appendChild(tableTitle);
  const tableWrap = el('div', 'table-wrap');
  const stepsTable = el('table', 'steps-table');
  const thead = el('thead');
  const headRow = el('tr');
  const thStep = el('th', 'nowrap');
  const thModel = el('th', 'nowrap');
  const thSpd = el('th', 'num');
  const thDur = el('th', 'num');
  const thOut = el('th', 'num');
  const thCtx = el('th', 'num');
  const thTools = el('th');
  headRow.appendChild(thStep);
  headRow.appendChild(thModel);
  headRow.appendChild(thSpd);
  headRow.appendChild(thDur);
  headRow.appendChild(thOut);
  headRow.appendChild(thCtx);
  headRow.appendChild(thTools);
  thead.appendChild(headRow);
  const tbody = el('tbody');
  stepsTable.appendChild(thead);
  stepsTable.appendChild(tbody);
  tableWrap.appendChild(stepsTable);
  tableCard.appendChild(tableHeader);
  tableCard.appendChild(tableWrap);

  // 7. Rolling 5h Window & Today Global Summary
  const aggCard = el('section', 'card');
  const aggHeader = el('div', 'card-header');
  const aggTitle = el('h2', 'card-title');
  const aggBadge = el('span', 'badge badge-ok');
  aggHeader.appendChild(aggTitle);
  aggHeader.appendChild(aggBadge);
  const aggGrid = el('div', 'kv-grid');

  const box5h = el('div', 'kv-box');
  const box5hLabel = el('span', 'kv-label');
  const box5hVal = el('span', 'kv-val tabular');
  const win5hTrack = el('div', 'win-track');
  const win5hFill = el('div', 'win-fill');
  win5hTrack.appendChild(win5hFill);
  const box5hSub = el('span', 'kv-sub tabular');
  const box5hResetSub = el('span', 'kv-sub tabular');
  box5h.appendChild(box5hLabel);
  box5h.appendChild(box5hVal);
  box5h.appendChild(win5hTrack);
  box5h.appendChild(box5hSub);
  box5h.appendChild(box5hResetSub);

  const boxToday = el('div', 'kv-box');
  const boxTodayLabel = el('span', 'kv-label');
  const boxTodayVal = el('span', 'kv-val tabular');
  const boxTodaySub = el('span', 'kv-sub tabular');
  const boxTodayThinkSub = el('span', 'kv-sub tabular');
  boxToday.appendChild(boxTodayLabel);
  boxToday.appendChild(boxTodayVal);
  boxToday.appendChild(boxTodaySub);
  boxToday.appendChild(boxTodayThinkSub);

  aggGrid.appendChild(box5h);
  aggGrid.appendChild(boxToday);
  aggCard.appendChild(aggHeader);
  aggCard.appendChild(aggGrid);

  content.appendChild(controlBar);
  content.appendChild(emptyBanner);
  content.appendChild(metricsGrid);
  content.appendChild(modelHubCard);
  content.appendChild(chartCard);
  content.appendChild(tableCard);
  content.appendChild(aggCard);

  root.appendChild(topbar);
  root.appendChild(content);

  // ---------------- Event Listeners ----------------
  langBtn.addEventListener('click', () => {
    state.lang = state.lang === 'zh' ? 'en' : 'zh';
    safeSetPref('agy_vitals_lang', state.lang);
    render();
  });

  convSelect.addEventListener('change', () => {
    state.selectedConv = convSelect.value;
    pollOnce();
  });

  limitSelect.addEventListener('change', () => {
    state.contextLimit = limitSelect.value || 'auto';
    safeSetPref('agy_vitals_limit', state.contextLimit);
    pollOnce();
  });

  // ---------------- Render Helpers ----------------
  function renderStaticLabels() {
    brandTitle.textContent = t('title');
    langBtn.textContent = t('langBtn');
    const themeMap = { auto: 'autoTheme', light: 'lightTheme', dark: 'darkTheme' };
    for (const [mode, btn] of themeButtons.entries()) {
      btn.textContent = t(themeMap[mode]);
      btn.classList.toggle('active', state.themeOverride === mode);
    }
    const scopeMap = { conv: 'scopeConv', '5h': 'scope5h', today: 'scopeToday' };
    for (const [sc, btn] of scopeButtons.entries()) {
      btn.textContent = t(scopeMap[sc]);
      btn.classList.toggle('active', state.modelScope === sc);
    }

    convLabel.textContent = t('convLabel');
    limitLabel.textContent = t('limitLabel');
    const detLimit = state.snapshot?.detectedContextLimit;
    autoOpt.textContent = detLimit ? `${t('autoLimit')} (${fmtTok(detLimit)})` : t('autoLimit');

    speedTitle.textContent = t('speedTitle');
    ctxTitle.textContent = t('contextTitle');
    cacheTitle.textContent = t('cacheTitle');
    cacheSubDesc.textContent = t('cacheSubDesc');
    modelHubTitle.textContent = t('modelHubTitle');
    chartTitle.textContent = t('chartTitle');
    tableTitle.textContent = t('tableTitle');
    aggTitle.textContent = t('aggTitle');
    aggBadge.textContent = t('verifiedTag');
    thStep.textContent = t('colStep');
    thModel.textContent = t('colModel');
    thSpd.textContent = t('colSpeed');
    thDur.textContent = t('colDur');
    thOut.textContent = t('colOut');
    thCtx.textContent = t('colCtx');
    thTools.textContent = t('colTools');
    box5hLabel.textContent = t('win5hLabel');
    boxTodayLabel.textContent = t('todayLabel');
  }

  function updateStatusPill() {
    const conv = state.snapshot?.conversation;
    if (!conv || !conv.activity) {
      statusPill.dataset.state = 'idle';
      statusText.textContent = t('stateIdle');
      return;
    }
    const act = conv.activity;
    statusPill.dataset.state = act.state || 'idle';
    if (act.state === 'idle') {
      statusText.textContent = t('stateIdle');
      return;
    }
    if (act.state === 'error') {
      statusText.textContent = t('stateError');
      return;
    }
    const extraSec = state.lastPollClientMs ? (Date.now() - state.lastPollClientMs) / 1000 : 0;
    const liveSec = Math.max(0, (act.elapsedSec || 0) + extraSec).toFixed(1);
    if (act.state === 'tool_running') {
      const toolTag = act.activeTools?.length ? `: ${act.activeTools[0]}` : '';
      statusText.textContent = `${t('stateTool')}${toolTag} · ${liveSec}s`;
    } else {
      statusText.textContent = `${t('stateGenerating')} · ${liveSec}s`;
    }
  }

  function syncConvDropdown(snap) {
    const recent = Array.isArray(snap?.recentConversations) ? snap.recentConversations : [];
    const optionsList = [{ value: '', label: t('autoConv') }];
    for (const item of recent) {
      const shortId = item.conversationId.slice(0, 8);
      const title = item.titlePreview || shortId;
      const modelTag = item.activeModel?.modelShort ? ` [${item.activeModel.modelShort}]` : '';
      const spd = item.lastTokPerSec !== null ? ` · ${item.lastTokPerSec} tok/s` : '';
      optionsList.push({
        value: item.conversationId,
        label: `${title} (${shortId})${modelTag}${spd}`,
      });
    }
    const sig = optionsList.map((o) => `${o.value}|${o.label}`).join('\n');
    if (convSelect.dataset.sig !== sig) {
      convSelect.dataset.sig = sig;
      const frag = document.createDocumentFragment();
      for (const item of optionsList) {
        const opt = el('option', '', item.label);
        opt.value = item.value;
        frag.appendChild(opt);
      }
      convSelect.replaceChildren(frag);
      convSelect.value = state.selectedConv;
    }
  }

  function renderModelHub(snap) {
    const conv = snap?.conversation;
    let byModel = [];
    if (state.modelScope === 'conv') {
      byModel = Array.isArray(conv?.byModel) ? conv.byModel : [];
    } else if (state.modelScope === '5h') {
      byModel = Array.isArray(snap?.rolling5h?.byModel) ? snap.rolling5h.byModel : [];
    } else {
      byModel = Array.isArray(snap?.today?.byModel) ? snap.today.byModel : [];
    }

    if (byModel.length === 0) {
      shareBarTrack.style.display = 'none';
      shareBarTrack.replaceChildren();
      modelListEl.replaceChildren(el('div', 'muted-note', t('noModels')));
      return;
    }

    shareBarTrack.style.display = 'flex';
    const shareFrag = document.createDocumentFragment();
    for (const m of byModel) {
      const seg = el('div', 'share-seg');
      seg.dataset.family = m.modelFamily || 'other';
      seg.style.width = `${Math.max(1, m.sharePercent || 0)}%`;
      seg.title = `${m.modelLabel}: ${m.sharePercent}% (${fmtTok(m.totalTokens)} tok)`;
      shareFrag.appendChild(seg);
    }
    shareBarTrack.replaceChildren(shareFrag);

    const maxAvgSpeed = Math.max(
      1,
      ...byModel.map((m) => (Number.isFinite(m.avgTokPerSec) ? m.avgTokPerSec : 0)),
    );

    const cardsFrag = document.createDocumentFragment();
    for (const m of byModel) {
      const card = el('div', 'model-card');
      const top = el('div', 'model-card-top');
      const nameWrap = el('div', 'model-name-wrap');
      const dot = el('span', 'family-dot');
      dot.dataset.family = m.modelFamily || 'other';
      const title = el('span', 'model-title', m.modelLabel);
      const pill = el('span', 'badge', m.modelShort || m.modelLabel);
      pill.dataset.family = m.modelFamily || 'other';
      nameWrap.appendChild(dot);
      nameWrap.appendChild(title);
      nameWrap.appendChild(pill);

      const shareMeta = el(
        'span',
        'model-share-meta tabular',
        `${m.steps} ${t('stepsWord')} · ${t('shareWord')} ${m.sharePercent}%`,
      );
      top.appendChild(nameWrap);
      top.appendChild(shareMeta);

      const grid = el('div', 'model-metrics-grid');

      const c1 = el('div', 'model-cell');
      c1.appendChild(el('span', 'model-cell-label', t('e2eAvg')));
      c1.appendChild(
        el('span', 'model-cell-val tabular', m.avgTokPerSec !== null ? `${m.avgTokPerSec} tok/s` : '-'),
      );
      c1.appendChild(
        el(
          'span',
          'model-cell-sub tabular',
          `${t('streamAvg')} ${m.avgStreamTokPerSec !== null ? `${m.avgStreamTokPerSec}` : '-'}`,
        ),
      );

      const c2 = el('div', 'model-cell');
      c2.appendChild(el('span', 'model-cell-label', t('avgTtft')));
      c2.appendChild(
        el('span', 'model-cell-val tabular', m.avgTtftSec !== null ? `${m.avgTtftSec}s` : '-'),
      );
      c2.appendChild(
        el('span', 'model-cell-sub tabular', `${t('timedSteps')} ${m.timedSteps}/${m.steps}`),
      );

      const c3 = el('div', 'model-cell');
      c3.appendChild(el('span', 'model-cell-label', t('outThink')));
      c3.appendChild(el('span', 'model-cell-val tabular', fmtTok(m.outputTokens)));
      c3.appendChild(
        el('span', 'model-cell-sub tabular', `${t('thinkLabel')} ${fmtTok(m.thinkingTokens)}`),
      );

      const c4 = el('div', 'model-cell');
      c4.appendChild(el('span', 'model-cell-label', t('totalTok')));
      c4.appendChild(el('span', 'model-cell-val tabular', fmtTok(m.totalTokens)));
      c4.appendChild(
        el('span', 'model-cell-sub tabular', `${t('segCache')} ${fmtTok(m.cacheReadTokens)}`),
      );

      grid.appendChild(c1);
      grid.appendChild(c2);
      grid.appendChild(c3);
      grid.appendChild(c4);

      const spdTrack = el('div', 'speed-compare-track');
      const spdFill = el('div', 'speed-compare-fill');
      spdFill.dataset.family = m.modelFamily || 'other';
      const relPct = m.avgTokPerSec !== null ? Math.max(4, Math.round((m.avgTokPerSec / maxAvgSpeed) * 100)) : 0;
      spdFill.style.width = `${relPct}%`;
      spdTrack.appendChild(spdFill);

      card.appendChild(top);
      card.appendChild(grid);
      card.appendChild(spdTrack);
      cardsFrag.appendChild(card);
    }
    modelListEl.replaceChildren(cardsFrag);
  }

  function renderSpeedChart(steps) {
    const recent = (Array.isArray(steps) ? steps : []).slice(-14);
    const nodes = [];
    const W = 620;
    const H = 152;
    const padL = 40;
    const padR = 12;
    const padT = 22;
    const padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const speeds = recent.map((s) => (s.tokPerSec !== null ? s.tokPerSec : 0));
    const maxSpd = Math.max(20, ...speeds);
    const niceMax = Math.ceil(maxSpd / 20) * 20;

    for (const ratio of [0, 0.5, 1]) {
      const y = padT + plotH * (1 - ratio);
      nodes.push(
        svgEl('line', {
          x1: padL,
          y1: y,
          x2: W - padR,
          y2: y,
          stroke: 'var(--pl-border-strong)',
          'stroke-width': 1,
          'stroke-dasharray': ratio === 0 ? 'none' : '3 3',
        }),
      );
      nodes.push(
        svgEl(
          'text',
          {
            x: padL - 6,
            y: y + 4,
            'text-anchor': 'end',
            fill: 'var(--pl-fg-subtle)',
            'font-size': 12,
            class: 'tabular',
          },
          Math.round(niceMax * ratio),
        ),
      );
    }

    if (recent.length === 0) {
      nodes.push(
        svgEl(
          'text',
          {
            x: padL + plotW / 2,
            y: padT + plotH / 2 + 4,
            'text-anchor': 'middle',
            fill: 'var(--pl-fg-muted)',
            'font-size': 12,
          },
          t('noSpeed'),
        ),
      );
      chartSvg.replaceChildren(...nodes);
      return;
    }

    const slotW = plotW / recent.length;
    const barW = Math.min(28, Math.max(10, slotW * 0.54));

    recent.forEach((step, idx) => {
      const cx = padL + slotW * idx + slotW / 2;
      const x = cx - barW / 2;
      const hasVal = step.tokPerSec !== null && step.tokPerSec > 0;
      const barH = hasVal ? Math.max(4, (step.tokPerSec / niceMax) * plotH) : 3;
      const y = padT + plotH - barH;
      const fillColor = hasVal ? FAMILY_FILL[step.modelFamily] || FAMILY_FILL.other : 'var(--pl-border)';

      const rect = svgEl('rect', {
        x: x.toFixed(1),
        y: y.toFixed(1),
        width: barW.toFixed(1),
        height: barH.toFixed(1),
        rx: 3,
        fill: fillColor,
      });

      const ttftPart = step.ttftSec !== null ? `TTFT ${step.ttftSec}s + Stream ${step.streamSec}s` : `${step.durationSec ?? '-'}s`;
      const streamPart = step.streamTokPerSec !== null ? ` | Post-TTFT ${step.streamTokPerSec} tok/s` : '';
      const thinkPart = step.thinkingTokens > 0 ? ` (Think ${fmtTok(step.thinkingTokens)})` : '';
      rect.appendChild(
        svgEl(
          'title',
          {},
          `#${step.stepIndex} · ${step.modelLabel || 'Unknown'} | ${hasVal ? `${step.tokPerSec} tok/s` : '-'}${streamPart} | ${ttftPart} | Out ${fmtTok(step.outputTokens)}${thinkPart}`,
        ),
      );
      nodes.push(rect);

      if (hasVal) {
        nodes.push(
          svgEl(
            'text',
            {
              x: cx.toFixed(1),
              y: Math.max(14, y - 5).toFixed(1),
              'text-anchor': 'middle',
              fill: 'var(--pl-fg-muted)',
              'font-size': 12,
              class: 'tabular',
            },
            Math.round(step.tokPerSec),
          ),
        );
      }

      nodes.push(
        svgEl(
          'text',
          {
            x: cx.toFixed(1),
            y: H - 6,
            'text-anchor': 'middle',
            fill: 'var(--pl-fg-subtle)',
            'font-size': 12,
            class: 'tabular',
          },
          `#${step.stepIndex}`,
        ),
      );
    });

    chartSvg.replaceChildren(...nodes);
  }

  function renderStepsTable(steps) {
    const list = (Array.isArray(steps) ? [...steps] : []).reverse().slice(0, 14);
    const frag = document.createDocumentFragment();
    for (const s of list) {
      const tr = el('tr');
      tr.appendChild(el('td', 'nowrap tabular', `#${s.stepIndex}`));

      const modelTd = el('td', 'nowrap');
      const pill = el('span', 'badge', s.modelShort || s.modelLabel || 'Unknown');
      pill.dataset.family = s.modelFamily || 'other';
      pill.title = s.modelLabel || 'Unknown';
      modelTd.appendChild(pill);
      tr.appendChild(modelTd);

      const spdTd = el('td', 'num tabular');
      spdTd.appendChild(el('span', '', s.tokPerSec !== null ? `${s.tokPerSec}` : '-'));
      if (s.streamTokPerSec !== null) {
        spdTd.appendChild(el('span', 'cell-sub', `/${s.streamTokPerSec}`));
      }
      tr.appendChild(spdTd);

      const durTd = el('td', 'num tabular');
      durTd.appendChild(el('span', '', s.durationSec !== null ? `${s.durationSec}s` : '-'));
      if (s.ttftSec !== null) {
        durTd.appendChild(el('span', 'cell-sub', `(${s.ttftSec}s)`));
      }
      tr.appendChild(durTd);

      const outTd = el('td', 'num tabular');
      outTd.appendChild(el('span', '', fmtTok(s.outputTokens)));
      if (s.thinkingTokens > 0) {
        outTd.appendChild(el('span', 'cell-sub', `(${fmtTok(s.thinkingTokens)})`));
      }
      tr.appendChild(outTd);

      tr.appendChild(el('td', 'num tabular', fmtTok(s.contextTotal)));
      const toolsStr = s.toolNames && s.toolNames.length ? s.toolNames.join(', ') : '-';
      const toolTd = el('td', 'tools-cell', toolsStr);
      toolTd.title = toolsStr;
      tr.appendChild(toolTd);

      frag.appendChild(tr);
    }
    tbody.replaceChildren(frag);
  }

  function render() {
    renderStaticLabels();
    const snap = state.snapshot;
    syncConvDropdown(snap);
    updateStatusPill();

    const conv = snap?.conversation;
    if (conv?.activeModel && conv.activeModel.modelKey !== 'Unknown') {
      activeModelPill.style.display = 'inline-flex';
      activeModelPill.dataset.family = conv.activeModel.modelFamily || 'other';
      activeModelDot.dataset.family = conv.activeModel.modelFamily || 'other';
      activeModelText.textContent = conv.activeModel.modelShort || conv.activeModel.modelLabel;
      activeModelPill.title = conv.activeModel.modelLabel;
    } else {
      activeModelPill.style.display = 'none';
    }

    if (state.errorMsg) {
      emptyBanner.style.display = 'block';
      emptyBanner.textContent = `${t('errFetch')}: ${state.errorMsg}`;
    } else if (!snap || !conv) {
      emptyBanner.style.display = 'block';
      emptyBanner.textContent = t('noData');
    } else {
      emptyBanner.style.display = 'none';
    }

    const hasConv = Boolean(conv);
    metricsGrid.style.display = hasConv ? 'grid' : 'none';
    chartCard.style.display = hasConv ? 'flex' : 'none';
    tableCard.style.display = hasConv ? 'flex' : 'none';

    if (conv) {
      // Hero Card 1: Speed & Latency
      const speedFam = conv.lastSpeedModelFamily || conv.activeModel?.modelFamily || 'carbon';
      speedCard.dataset.accent = speedFam;
      if (conv.lastTokPerSec !== null) {
        speedHero.replaceChildren(
          el('span', '', String(conv.lastTokPerSec)),
          el('span', 'hero-unit', 'tok/s'),
        );
        const mTag = conv.lastSpeedModelShort ? ` · ${conv.lastSpeedModelShort}` : '';
        speedBadge.className = 'badge';
        speedBadge.dataset.family = speedFam;
        speedBadge.textContent = `#${conv.lastSpeedStepIndex}${mTag}`;
      } else {
        speedHero.replaceChildren(el('span', '', t('noSpeed')));
        speedBadge.className = 'badge badge-neutral';
        delete speedBadge.dataset.family;
        speedBadge.textContent = '-';
      }

      const streamVal = conv.lastStreamTokPerSec !== null ? `${conv.lastStreamTokPerSec} tok/s` : '-';
      const ttftVal = conv.lastTtftSec !== null ? `${conv.lastTtftSec}s` : '-';
      const avgVal = conv.totals.avgTokPerSec !== null ? `${conv.totals.avgTokPerSec} tok/s` : '-';
      speedChips.replaceChildren(
        metricChip(t('streamSpeed'), streamVal),
        metricChip(t('ttftLabel'), ttftVal),
        metricChip(t('avgSpeed'), avgVal),
      );

      // Hero Card 2: Context Runway
      const limit = Math.max(1, conv.contextLimit || 256000);
      const pct = Math.min(100, Math.max(0, conv.usagePercent || 0));
      const lvl = pct >= 85 ? 'err' : pct >= 50 ? 'warn' : 'ok';
      ctxCard.dataset.accent = lvl;
      ctxHero.textContent = `${fmtTok(conv.contextUsed)} / ${fmtTok(limit)}`;
      ctxPctPill.className = `badge badge-${lvl} tabular`;
      ctxPctPill.textContent = `${conv.usagePercent}%`;
      ctxBadge.className = `badge badge-${lvl}`;
      ctxBadge.textContent = lvl === 'err' ? t('lvlErr') : lvl === 'warn' ? t('lvlWarn') : t('lvlOk');

      const cacheSegTok = conv.latestCacheReadTokens || 0;
      const freshSegTok = (conv.latestInputTokens || 0) + (conv.latestCacheCreationTokens || 0);
      const outSegTok = conv.latestOutputTokens || 0;
      const cacheW = Math.min(100, (cacheSegTok / limit) * 100);
      const inputW = Math.min(Math.max(0, 100 - cacheW), (freshSegTok / limit) * 100);
      const outW = Math.min(Math.max(0, 100 - cacheW - inputW), (outSegTok / limit) * 100);
      segCacheEl.style.width = `${cacheW.toFixed(2)}%`;
      segInputEl.style.width = `${inputW.toFixed(2)}%`;
      segOutEl.style.width = `${outW.toFixed(2)}%`;

      ctxLegend.replaceChildren(
        legendDot('', `${t('segCache')} ${fmtTok(cacheSegTok)}`, 'hydrogen'),
        legendDot('', `${t('segInput')} ${fmtTok(freshSegTok)}`, 'carbon'),
        legendDot('warn-dot', `${t('segOut')} ${fmtTok(outSegTok)}`),
        el('span', '', `${t('remain')} ${fmtTok(conv.remainTokens)}`),
      );

      if (conv.nearCompaction || (conv.compactions && conv.compactions.length > 0)) {
        const msgs = [];
        if (conv.nearCompaction) msgs.push(t('nearCompactWarn'));
        if (conv.compactions?.length) {
          const lastC = conv.compactions[conv.compactions.length - 1];
          msgs.push(
            `${t('compactedPrefix')}: #${lastC.stepIndex} (${fmtTok(lastC.beforeTokens)} -> ${fmtTok(lastC.afterTokens)})`,
          );
        }
        ctxWarn.style.display = 'block';
        ctxWarn.textContent = msgs.join(' ');
      } else {
        ctxWarn.style.display = 'none';
      }

      // Hero Card 3: Cache Ring & Thinking Split
      const hitPct = Math.min(100, Math.max(0, conv.cacheHitRate || 0));
      ringFill.setAttribute('stroke-dashoffset', (RING_CIRC * (1 - hitPct / 100)).toFixed(2));
      cacheHero.textContent = `${conv.cacheHitRate}%`;
      cacheBadge.textContent = `${t('sessionCache')} ${conv.totals.sessionCacheHitRate}%`;

      const sessThink = conv.totals.thinkingTokens || 0;
      const sessOut = Math.max(0, conv.totals.outputTokens || 0);
      const sessText = Math.max(0, sessOut - sessThink);
      const thinkPct = sessOut > 0 ? Math.min(100, (sessThink / sessOut) * 100) : 0;
      const textPct = sessOut > 0 ? Math.max(0, 100 - thinkPct) : 0;
      splitThinkBar.style.width = `${thinkPct.toFixed(1)}%`;
      splitTextBar.style.width = `${textPct.toFixed(1)}%`;

      cacheLegend.replaceChildren(
        legendDot('', `${t('thinkLabel')} ${fmtTok(sessThink)}`, 'argon'),
        legendDot('', `${t('textLabel')} ${fmtTok(sessText)}`, 'carbon'),
        el('span', '', `${conv.totals.plannerSteps} ${t('stepsUnit')}`),
      );

      renderSpeedChart(conv.recentPlannerSteps);
      renderStepsTable(conv.recentPlannerSteps);
    }

    renderModelHub(snap);

    if (snap) {
      const r5 = snap.rolling5h;
      const td = snap.today;
      box5hVal.textContent = `${fmtTok(r5.totalTokens)} tok (${r5.conversations} ${t('convsUnit')})`;
      const elapsed5hRatio =
        r5.oldestStepMs > 0
          ? Math.min(100, Math.max(2, ((FIVE_HOURS_MS - r5.resetInMs) / FIVE_HOURS_MS) * 100))
          : 0;
      win5hFill.style.width = `${elapsed5hRatio.toFixed(1)}%`;
      const think5h = r5.thinkingTokens > 0 ? ` · ${t('thinkLabel')} ${fmtTok(r5.thinkingTokens)}` : '';
      box5hSub.textContent = `In ${fmtTok(r5.inputTokens)} / Cache ${fmtTok(r5.cacheReadTokens)} / Out ${fmtTok(r5.outputTokens)}${think5h}`;
      box5hResetSub.textContent =
        r5.oldestStepMs > 0
          ? `${t('win5hReset')}: ${fmtDurMs(r5.resetInMs)} (${r5.plannerSteps} ${t('stepsUnit')})`
          : t('win5hEmpty');

      boxTodayVal.textContent = `${fmtTok(td.totalTokens)} tok (${td.conversations} ${t('convsUnit')})`;
      const thinkTd = td.thinkingTokens > 0 ? ` · ${t('thinkLabel')} ${fmtTok(td.thinkingTokens)}` : '';
      boxTodaySub.textContent = `In ${fmtTok(td.inputTokens)} / Cache ${fmtTok(td.cacheReadTokens)} / Out ${fmtTok(td.outputTokens)}`;
      boxTodayThinkSub.textContent = `${td.plannerSteps} ${t('stepsUnit')}${thinkTd}`;
    }
  }

  let polling = false;
  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      const qs = new URLSearchParams();
      const targetConv = state.selectedConv || window.sidecar?.conversationId || '';
      if (targetConv) qs.set('conversationId', targetConv);
      qs.set('contextLimit', String(state.contextLimit || 'auto'));
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await f(`/api/vitals?${qs.toString()}`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.snapshot = await res.json();
      state.lastPollClientMs = Date.now();
      state.errorMsg = '';
    } catch (err) {
      state.errorMsg = err?.message || String(err);
    } finally {
      polling = false;
      render();
    }
  }

  renderStaticLabels();
  pollOnce();
  setInterval(pollOnce, POLL_MS);
  setInterval(updateStatusPill, STOPWATCH_MS);
})();
