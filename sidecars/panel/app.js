let limitsOpen = false;
let saveStatusTimer = null;
let copyFeedbackTimer = null;

function getSidecarTheme() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, transparent)';
  document.documentElement.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const nums = (c.match(/[\d.]+/g) || []).map(Number);
  if (nums.length >= 3 && (nums.length < 4 || nums[3] > 0)) {
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum < 0.5 ? 'dark' : 'light';
  }
  if (window.sidecar && window.sidecar.theme) {
    return String(window.sidecar.theme).toLowerCase().includes('dark') ? 'dark' : 'light';
  }
  if (document.body && document.body.classList) {
    if (document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast')) {
      return 'dark';
    }
    if (document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light')) {
      return 'light';
    }
  }
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function syncTheme() {
  const theme = getSidecarTheme();
  if (document.documentElement.getAttribute('data-theme') !== theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

syncTheme();
new MutationObserver(() => syncTheme()).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['style', 'class']
});
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', syncTheme);
}

function formatTokens(n) {
  const num = Number(n) || 0;
  if (num >= 999950) {
    const m = num / 1000000;
    if (m >= 100) return `${Math.round(m)}M`;
    if (m >= 10) return `${m.toFixed(1)}M`;
    return `${m.toFixed(2)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return String(Math.round(num));
}

function formatCap(n) {
  const num = Number(n) || 1000000;
  if (num >= 1000000 && num % 1000000 === 0) {
    return `${num / 1000000}M`;
  }
  return formatTokens(num);
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) {
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

function formatReset(mins) {
  const total = Number(mins) || 0;
  if (total <= 0) return '';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatMinutes(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function formatProjectRef(env) {
  if (!env || !env.projectName) return null;
  if (env.gitBranch) {
    return `${env.projectName} · ${env.gitBranch}${env.gitDirty ? '*' : ''}`;
  }
  return env.projectName;
}

function pluralize(count, singular, plural) {
  const n = Number(count) || 0;
  return `${n} ${n === 1 ? singular : plural}`;
}

function syncLimitsState() {
  const form = document.getElementById('limits-form');
  const btn = document.getElementById('toggle-limits');
  form.hidden = !limitsOpen;
  btn.setAttribute('aria-expanded', limitsOpen ? 'true' : 'false');
}

function syncConfigInputs(cfg, force) {
  const form = document.getElementById('limits-form');
  if (!force && form.contains(document.activeElement)) return;
  document.getElementById('in-limit-5h').value = Math.round((cfg.limit5hTokens || 0) / 1000);
  document.getElementById('in-limit-7d').value = Math.round((cfg.limit7dTokens || 0) / 1000);
  document.getElementById('in-compact-pct').value = cfg.compactThresholdPct || 65;
}

function renderModels(listEl, models, showBars) {
  listEl.innerHTML = '';
  for (const m of models) {
    const entry = document.createElement('div');
    entry.className = 'model-entry';

    const line = document.createElement('div');
    line.className = 'model-line';

    const label = document.createElement('div');
    label.className = m.isActive ? 'model-label active' : 'model-label';

    if (m.isActive) {
      const pip = document.createElement('span');
      pip.className = 'model-pip';
      label.appendChild(pip);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'model-label-text';
    nameSpan.textContent = m.name;
    nameSpan.title = m.name;
    label.appendChild(nameSpan);

    const stats = document.createElement('div');
    stats.className = 'model-stats';

    const tok = document.createElement('span');
    tok.className = 'model-tok';
    tok.textContent = formatTokens(m.tokens);

    const pct = document.createElement('span');
    pct.className = 'model-pct';
    pct.textContent = `${Number(m.pct || 0).toFixed(0)}%`;

    stats.appendChild(tok);
    stats.appendChild(pct);

    line.appendChild(label);
    line.appendChild(stats);
    entry.appendChild(line);

    if (showBars) {
      const bar = document.createElement('div');
      bar.className = 'model-bar';
      const fill = document.createElement('div');
      fill.className = 'model-bar-fill';
      fill.style.width = `${Math.min(100, Math.max(2, Number(m.pct) || 0))}%`;
      bar.appendChild(fill);
      entry.appendChild(bar);
    }

    listEl.appendChild(entry);
  }
}

function renderDailyBars(container, daily) {
  container.innerHTML = '';
  if (!Array.isArray(daily) || daily.length === 0) return;
  const maxTok = Math.max(1, ...daily.map((d) => Number(d.tokens) || 0));
  for (const d of daily) {
    const tok = Number(d.tokens) || 0;
    const col = document.createElement('div');
    col.className = 'daily-col';
    col.title = `${d.label}: ${formatTokens(tok)} · ${pluralize(d.turns, 'turn', 'turns')}`;

    const wrap = document.createElement('div');
    wrap.className = 'daily-bar-wrap';

    const bar = document.createElement('div');
    bar.className = tok > 0 ? (d.isToday ? 'daily-bar today' : 'daily-bar') : 'daily-bar empty';
    const pct = tok > 0 ? Math.max(10, Math.round((tok / maxTok) * 100)) : 6;
    bar.style.height = `${pct}%`;

    const lbl = document.createElement('span');
    lbl.className = d.isToday ? 'daily-label today' : 'daily-label';
    lbl.textContent = d.label;

    wrap.appendChild(bar);
    col.appendChild(wrap);
    col.appendChild(lbl);
    container.appendChild(col);
  }
}

function render(data) {
  const dot = document.getElementById('status-dot');
  const modelEl = document.getElementById('model-name');

  if (data.active) {
    modelEl.textContent = data.modelName || 'Active session';
    modelEl.classList.add('active');
    dot.classList.toggle('busy', Boolean(data.isAgentActive));
    dot.classList.toggle('idle', !data.isAgentActive);
  } else {
    modelEl.textContent = 'No active session';
    modelEl.classList.remove('active');
    dot.classList.remove('busy', 'idle');
  }

  const env = data.environment || {
    projectName: null,
    gitBranch: null,
    gitDirty: false,
    location: 'Local',
    rulesCount: 0,
    mcpCount: 0,
    pluginsCount: 0,
    skillsCount: 0
  };
  const projectRef = formatProjectRef(env);

  const cfg = data.config || { limit5hTokens: 0, limit7dTokens: 0, compactThresholdPct: 65 };
  const threshold = Math.min(95, Math.max(10, Number(cfg.compactThresholdPct) || 65));
  syncConfigInputs(cfg, false);

  const hasCustomLimits = cfg.limit5hTokens > 0 || cfg.limit7dTokens > 0;
  document.getElementById('limits-summary').textContent = hasCustomLimits
    ? `Limits on · ${threshold}%`
    : `${threshold}%`;

  const ctx = data.context || { used: 0, max: 1000000, pct: 0, compactRecommended: false };
  const pctVal = Number(ctx.pct) || 0;
  const recommendCompact = Boolean(ctx.compactRecommended);

  document.getElementById('ctx-pct').textContent = `${pctVal.toFixed(1)}%`;
  document.getElementById('ctx-used').textContent = formatTokens(ctx.used);
  document.getElementById('ctx-max').textContent = `/ ${formatCap(ctx.max)}`;

  const thresholdLabel = document.getElementById('ctx-threshold-label');
  thresholdLabel.textContent = recommendCompact ? `Over ${threshold}%` : `Alert at ${threshold}%`;
  thresholdLabel.classList.toggle('strong', recommendCompact);

  const ctxBar = document.getElementById('ctx-bar');
  ctxBar.style.width = `${Math.min(100, Math.max(0, pctVal))}%`;
  ctxBar.classList.toggle('high', recommendCompact);

  const ctxTick = document.getElementById('ctx-tick');
  ctxTick.style.left = `${threshold}%`;

  document.getElementById('compact-cue').hidden = !recommendCompact;

  const rolling = data.rolling || {};
  const w5h = rolling.window5h || { tokens: 0, input: 0, cache: 0, output: 0, turns: 0, conversations: 0, resetInMinutes: null };
  const w7d = rolling.window7d || { tokens: 0, input: 0, cache: 0, output: 0, turns: 0, conversations: 0, models: [] };

  const resetStr = formatReset(w5h.resetInMinutes);
  const w5hSubhead = document.getElementById('w5h-subhead');
  w5hSubhead.textContent = resetStr ? `↻ ${resetStr}` : 'Rolling';
  w5hSubhead.title = resetStr ? `Oldest 5h usage expires in ${resetStr}` : '5-hour rolling window';

  const w5hTrack = document.getElementById('w5h-track');
  if (cfg.limit5hTokens > 0) {
    const pct5h = Math.min(999, (w5h.tokens / cfg.limit5hTokens) * 100);
    document.getElementById('w5h-val').textContent = `${pct5h.toFixed(0)}%`;
    document.getElementById('w5h-meta').textContent = `${formatTokens(w5h.tokens)} / ${formatTokens(cfg.limit5hTokens)}`;
    w5hTrack.hidden = false;
    const bar5h = document.getElementById('w5h-bar');
    bar5h.style.width = `${Math.min(100, Math.max(0, pct5h))}%`;
    bar5h.classList.toggle('high', pct5h >= 85);
  } else {
    document.getElementById('w5h-val').textContent = formatTokens(w5h.tokens);
    document.getElementById('w5h-meta').textContent = pluralize(w5h.turns, 'turn', 'turns');
    w5hTrack.hidden = true;
  }

  const w7dSubhead = document.getElementById('w7d-subhead');
  w7dSubhead.textContent = w7d.conversations > 0 ? pluralize(w7d.conversations, 'chat', 'chats') : 'Weekly';

  const w7dTrack = document.getElementById('w7d-track');
  if (cfg.limit7dTokens > 0) {
    const pct7d = Math.min(999, (w7d.tokens / cfg.limit7dTokens) * 100);
    document.getElementById('w7d-val').textContent = `${pct7d.toFixed(0)}%`;
    document.getElementById('w7d-meta').textContent = `${formatTokens(w7d.tokens)} / ${formatTokens(cfg.limit7dTokens)}`;
    w7dTrack.hidden = false;
    const bar7d = document.getElementById('w7d-bar');
    bar7d.style.width = `${Math.min(100, Math.max(0, pct7d))}%`;
    bar7d.classList.toggle('high', pct7d >= 85);
  } else {
    document.getElementById('w7d-val').textContent = formatTokens(w7d.tokens);
    document.getElementById('w7d-meta').textContent = pluralize(w7d.turns, 'turn', 'turns');
    w7dTrack.hidden = true;
  }

  const sess = data.session || { input: 0, cache: 0, output: 0, tokens: 0, turns: 0, toolCalls: 0, durationMinutes: 0, models: [] };
  document.getElementById('sess-turns').textContent = pluralize(sess.turns, 'turn', 'turns');
  document.getElementById('sess-input').textContent = formatTokens(sess.input);
  document.getElementById('sess-cache').textContent = formatTokens(sess.cache);
  document.getElementById('sess-output').textContent = formatTokens(sess.output);
  document.getElementById('sess-total').textContent = formatTokens(sess.tokens);
  document.getElementById('sess-activity').textContent = `${pluralize(sess.toolCalls, 'tool', 'tools')} · ${formatMinutes(sess.durationMinutes)}`;

  const task = data.currentTask || { tokens: 0, turns: 0, durationSeconds: 0 };
  const taskState = document.getElementById('task-state');
  if (!data.active) {
    taskState.textContent = 'Inactive';
    taskState.classList.remove('strong');
  } else if (data.isAgentActive) {
    taskState.textContent = 'Active';
    taskState.classList.add('strong');
  } else {
    taskState.textContent = task.turns > 0 ? 'Done' : 'Idle';
    taskState.classList.remove('strong');
  }
  document.getElementById('task-tokens').textContent = formatTokens(task.tokens);
  document.getElementById('task-turns').textContent = String(task.turns || 0);
  document.getElementById('task-duration').textContent = formatDuration(task.durationSeconds);

  const modelsBlock = document.getElementById('models-block');
  const modelsTitle = document.getElementById('models-title');
  const modelsCount = document.getElementById('models-count');
  const modelsList = document.getElementById('models-list');

  if (sess.models && sess.models.length > 1) {
    modelsBlock.hidden = false;
    modelsTitle.textContent = 'Session models';
    modelsCount.textContent = `${sess.models.length} used`;
    renderModels(modelsList, sess.models, true);
  } else {
    modelsBlock.hidden = true;
  }

  const sub = data.subagents || { count: 0, activeCount: 0, tokens: 0, turns: 0 };
  const subBlock = document.getElementById('subagents-block');
  if (sub.count > 0) {
    subBlock.hidden = false;
    const subActive = document.getElementById('sub-active');
    subActive.textContent = sub.activeCount > 0 ? `${sub.activeCount} active` : '';
    subActive.classList.toggle('strong', sub.activeCount > 0);
    document.getElementById('sub-count').textContent = String(sub.count);
    document.getElementById('sub-turns').textContent = String(sub.turns || 0);
    document.getElementById('sub-tokens').textContent = formatTokens(sub.tokens);
  } else {
    subBlock.hidden = true;
  }

  document.getElementById('w5h-in').textContent = formatTokens(w5h.input);
  document.getElementById('w7d-in').textContent = formatTokens(w7d.input);
  document.getElementById('w5h-out').textContent = formatTokens(w5h.output);
  document.getElementById('w7d-out').textContent = formatTokens(w7d.output);
  document.getElementById('w5h-cache').textContent = formatTokens(w5h.cache);
  document.getElementById('w7d-cache').textContent = formatTokens(w7d.cache);
  document.getElementById('w5h-turns').textContent = String(w5h.turns || 0);
  document.getElementById('w7d-turns').textContent = String(w7d.turns || 0);
  document.getElementById('w5h-chats').textContent = String(w5h.conversations || 0);
  document.getElementById('w7d-chats').textContent = String(w7d.conversations || 0);

  const daily = Array.isArray(w7d.daily) ? w7d.daily : [];
  const todayItem = daily.find((d) => d.isToday);
  document.getElementById('activity-7d-meta').textContent = todayItem
    ? `Today ${formatTokens(todayItem.tokens)}`
    : 'Last 7 days';
  renderDailyBars(document.getElementById('activity-7d-bars'), daily);

  const models7dBlock = document.getElementById('models-7d-block');
  const models7dCount = document.getElementById('models-7d-count');
  const models7dList = document.getElementById('models-7d-list');
  const top7d = Array.isArray(w7d.models) ? w7d.models.slice(0, 4) : [];
  if (top7d.length > 0) {
    models7dBlock.hidden = false;
    models7dCount.textContent = top7d.length > 1 ? `Top ${top7d.length}` : '';
    renderModels(models7dList, top7d, top7d.length > 1);
  } else {
    models7dBlock.hidden = true;
  }

  const envProjEl = document.getElementById('env-project');
  envProjEl.textContent = projectRef || 'No project';
  envProjEl.title = projectRef || '';
  document.getElementById('env-mode').textContent = env.location || 'Local';
  document.getElementById('env-rules').textContent = pluralize(env.rulesCount, 'file', 'files');
  document.getElementById('env-mcp').textContent = pluralize(env.mcpCount, 'server', 'servers');
  document.getElementById('env-plugins-skills').textContent = `${Number(env.pluginsCount) || 0} · ${Number(env.skillsCount) || 0}`;
}

async function copyCompactCommand() {
  let copied = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText('/compact');
      copied = true;
    } catch {}
  }
  if (!copied) {
    try {
      const ta = document.createElement('textarea');
      ta.value = '/compact';
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      copied = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {}
  }
  const actionEl = document.getElementById('compact-cue-action');
  actionEl.textContent = copied ? 'Copied' : '/compact';
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = setTimeout(() => {
    actionEl.textContent = 'Copy';
  }, 1600);
}

function sidecarFetch(url, opts) {
  const f = window.sidecar && window.sidecar.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
  return f(url, opts);
}

function getWorkspaceParams() {
  const sc = window.sidecar;
  if (!sc) return { workspacePath: '', workspaceUri: '' };
  let workspaceUri = typeof sc.workspaceUri === 'string' ? sc.workspaceUri : '';
  let workspacePath = typeof sc.workspacePath === 'string' ? sc.workspacePath : '';
  if (!workspacePath && !workspaceUri && sc.workspace) {
    if (typeof sc.workspace === 'string') {
      if (sc.workspace.includes('://')) workspaceUri = sc.workspace;
      else workspacePath = sc.workspace;
    } else if (typeof sc.workspace === 'object') {
      if (typeof sc.workspace.uri === 'string') workspaceUri = sc.workspace.uri;
      if (typeof sc.workspace.path === 'string') workspacePath = sc.workspace.path;
    }
  }
  if (!workspacePath && typeof sc.cwd === 'string') {
    workspacePath = sc.cwd;
  }
  return { workspacePath, workspaceUri };
}

async function poll() {
  syncTheme();
  const convId = window.sidecar && window.sidecar.conversationId ? window.sidecar.conversationId : '';
  const { workspacePath, workspaceUri } = getWorkspaceParams();
  const qs = new URLSearchParams();
  if (convId) qs.set('conversationId', convId);
  if (workspacePath) qs.set('workspacePath', workspacePath);
  if (workspaceUri) qs.set('workspaceUri', workspaceUri);
  const query = qs.toString();
  try {
    const res = await sidecarFetch(query ? `/api/stats?${query}` : '/api/stats');
    if (!res.ok) return;
    const data = await res.json();
    render(data);
  } catch {}
}

function init() {
  syncTheme();
  syncLimitsState();

  document.getElementById('compact-cue').addEventListener('click', copyCompactCommand);

  document.getElementById('toggle-limits').addEventListener('click', () => {
    limitsOpen = !limitsOpen;
    syncLimitsState();
  });

  document.getElementById('limits-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const l5 = Math.max(0, Math.round((Number(document.getElementById('in-limit-5h').value) || 0) * 1000));
    const l7 = Math.max(0, Math.round((Number(document.getElementById('in-limit-7d').value) || 0) * 1000));
    const rawPct = Number(document.getElementById('in-compact-pct').value);
    const cp = Number.isFinite(rawPct) ? Math.min(95, Math.max(10, Math.round(rawPct))) : 65;
    const status = document.getElementById('save-status');

    try {
      const res = await sidecarFetch(`/api/config/save?limit5hTokens=${l5}&limit7dTokens=${l7}&compactThresholdPct=${cp}`);
      if (res.ok) {
        const payload = await res.json();
        if (payload && payload.config) {
          syncConfigInputs(payload.config, true);
        }
        status.textContent = 'Saved';
        status.classList.add('strong');
        if (saveStatusTimer) clearTimeout(saveStatusTimer);
        saveStatusTimer = setTimeout(() => {
          status.textContent = '0 disables limit';
          status.classList.remove('strong');
        }, 1800);
        poll();
      }
    } catch {
      status.textContent = 'Save failed';
    }
  });

  poll();
  setInterval(poll, 2500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
