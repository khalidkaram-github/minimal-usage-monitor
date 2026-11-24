import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..', '..');
const CONFIG_PATH = join(PLUGIN_ROOT, 'config.json');
const BRAIN_DIR = join(homedir(), '.gemini', 'antigravity', 'brain');

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONTEXT_TOKENS = 1000000;
const ROLLING_CACHE_TTL_MS = 10000;

const DEFAULT_CONFIG = {
  limit5hTokens: 0,
  limit7dTokens: 0,
  compactThresholdPct: 65
};

const transcriptCache = new Map();
let rollingCache = { ts: 0, data: null };

const app = new SidecarApp();
const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

app.page('/', () => readLocal('index.html'));
app.api('/app.js', () => new Response(readLocal('app.js'), { contentType: 'application/javascript' }), 'GET');
app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css' }), 'GET');

function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      return {
        limit5hTokens: Math.max(0, Number(parsed.limit5hTokens) || 0),
        limit7dTokens: Math.max(0, Number(parsed.limit7dTokens) || 0),
        compactThresholdPct: Math.min(95, Math.max(10, Number(parsed.compactThresholdPct) || 65))
      };
    } catch {}
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function formatModelName(raw) {
  if (!raw) return 'Unknown';
  const cleaned = String(raw).trim();
  if (!cleaned) return 'Unknown';
  if (cleaned.includes(' ') && !cleaned.includes('-')) return cleaned;
  const parts = cleaned.split(/[-_]+/).filter(Boolean);
  const tiers = new Set(['low', 'medium', 'high', 'max']);
  let tier = null;
  if (parts.length > 1 && tiers.has(parts[parts.length - 1].toLowerCase())) {
    const t = parts.pop();
    tier = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  }
  const label = parts
    .map((p) => (/^\d+(\.\d+)?$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
    .join(' ');
  return tier ? `${label} (${tier})` : label;
}

function extractModelSelection(step) {
  if (step.source === 'MODEL' || step.type === 'GENERIC') return null;
  if (!step.content || !step.content.includes('Model Selection')) return null;
  const match = step.content.match(/Model Selection` from .+? to (.+?)\.\s*(?:No need|$)/i);
  return match ? match[1].trim() : null;
}

function extractSpawnedIds(text, excludedSet) {
  const found = [];
  if (!text || (!text.includes('conversationId') && !text.includes('invoke_subagent'))) {
    return found;
  }
  const matches = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  if (matches) {
    for (const id of matches) {
      if (!excludedSet.has(id)) {
        found.push(id);
      }
    }
  }
  return found;
}

function parseTranscriptFile(filePath) {
  if (!existsSync(filePath)) return null;
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }

  const cached = transcriptCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.parsed;
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  let currentModel = null;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let lastInput = 0;
  let lastCacheRead = 0;
  let lastOutput = 0;
  let firstTime = null;
  let lastTime = null;
  let lastUserIdx = -1;
  let modelTurns = 0;
  const events = [];
  const spawnedCandidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }

    const sel = extractModelSelection(step);
    if (sel) currentModel = sel;
    if (step.model) currentModel = formatModelName(step.model);

    const ts = step.created_at ? Date.parse(step.created_at) : NaN;
    if (!Number.isNaN(ts)) {
      if (firstTime === null || ts < firstTime) firstTime = ts;
      if (lastTime === null || ts > lastTime) lastTime = ts;
    }

    if (step.source === 'USER_EXPLICIT' || step.type === 'USER_INPUT') {
      lastUserIdx = events.length;
    }

    const stepStr = (step.content || '') + (step.tool_calls ? JSON.stringify(step.tool_calls) : '');
    if (stepStr.includes('conversationId') || stepStr.includes('invoke_subagent')) {
      spawnedCandidates.push({ text: stepStr, afterLastUser: lastUserIdx !== -1 });
    }

    const isModelStep = step.source === 'MODEL' && (step.type === 'PLANNER_RESPONSE' || step.input_tokens !== undefined || step.output_tokens !== undefined);
    if (isModelStep) {
      const inTok = Number(step.input_tokens) || 0;
      const cacheTok = Number(step.cache_read_tokens) || 0;
      const outTok = Number(step.output_tokens) || 0;
      if (inTok > 0 || cacheTok > 0 || outTok > 0) {
        modelTurns++;
        totalInput += inTok;
        totalCacheRead += cacheTok;
        totalOutput += outTok;
        lastInput = inTok;
        lastCacheRead = cacheTok;
        lastOutput = outTok;
        events.push({
          ts: Number.isNaN(ts) ? 0 : ts,
          model: step.model ? formatModelName(step.model) : (currentModel || 'Unknown'),
          input: inTok,
          cache: cacheTok,
          output: outTok,
          isModel: true
        });
      }
    } else {
      events.push({
        ts: Number.isNaN(ts) ? 0 : ts,
        isModel: false
      });
    }
  }

  const parsed = {
    totalInput,
    totalCacheRead,
    totalOutput,
    lastInput,
    lastCacheRead,
    lastOutput,
    firstTime,
    lastTime,
    lastUserIdx,
    modelTurns,
    stepCount: lines.length,
    activeModel: currentModel || 'Unknown',
    events,
    spawnedCandidates
  };

  transcriptCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  return parsed;
}

function getRollingUsage(now) {
  if (rollingCache.data && now - rollingCache.ts < ROLLING_CACHE_TTL_MS) {
    return rollingCache.data;
  }

  const cutoff5h = now - FIVE_HOURS_MS;
  const cutoff7d = now - SEVEN_DAYS_MS;

  const w5h = { input: 0, cache: 0, output: 0, tokens: 0, turns: 0, conversations: 0, oldestTs: null };
  const w7d = { input: 0, cache: 0, output: 0, tokens: 0, turns: 0, conversations: 0, models: {} };

  if (existsSync(BRAIN_DIR)) {
    let entries = [];
    try {
      entries = readdirSync(BRAIN_DIR, { withFileTypes: true });
    } catch {}

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const logPath = join(BRAIN_DIR, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      let st;
      try {
        st = statSync(logPath);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff7d) continue;

      const parsed = parseTranscriptFile(logPath);
      if (!parsed) continue;

      let had5h = false;
      let had7d = false;

      for (const ev of parsed.events) {
        if (!ev.isModel || !ev.ts) continue;
        if (ev.ts >= cutoff7d) {
          had7d = true;
          const tok = ev.input + ev.output;
          w7d.input += ev.input;
          w7d.cache += ev.cache;
          w7d.output += ev.output;
          w7d.tokens += tok;
          w7d.turns++;
          w7d.models[ev.model] = (w7d.models[ev.model] || 0) + tok;

          if (ev.ts >= cutoff5h) {
            had5h = true;
            w5h.input += ev.input;
            w5h.cache += ev.cache;
            w5h.output += ev.output;
            w5h.tokens += tok;
            w5h.turns++;
            if (w5h.oldestTs === null || ev.ts < w5h.oldestTs) {
              w5h.oldestTs = ev.ts;
            }
          }
        }
      }

      if (had5h) w5h.conversations++;
      if (had7d) w7d.conversations++;
    }
  }

  const topModels7d = Object.entries(w7d.models)
    .map(([name, tokens]) => ({
      name,
      tokens,
      pct: w7d.tokens > 0 ? Number(((tokens / w7d.tokens) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  const resetInMinutes5h = w5h.oldestTs
    ? Math.max(1, Math.ceil((w5h.oldestTs + FIVE_HOURS_MS - now) / 60000))
    : null;

  const data = {
    window5h: {
      tokens: w5h.tokens,
      input: w5h.input,
      cache: w5h.cache,
      output: w5h.output,
      turns: w5h.turns,
      conversations: w5h.conversations,
      resetInMinutes: resetInMinutes5h
    },
    window7d: {
      tokens: w7d.tokens,
      input: w7d.input,
      cache: w7d.cache,
      output: w7d.output,
      turns: w7d.turns,
      conversations: w7d.conversations,
      models: topModels7d
    }
  };

  rollingCache = { ts: now, data };
  return data;
}

app.api('/api/stats', (params) => {
  const now = Date.now();
  const config = loadConfig();
  const rolling = getRollingUsage(now);
  const conversationId = params.conversationId || app.config?.conversationId || '';

  if (!conversationId) {
    return {
      active: false,
      config,
      rolling
    };
  }

  const transcriptPath = join(BRAIN_DIR, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  const main = parseTranscriptFile(transcriptPath);

  if (!main) {
    return {
      active: true,
      conversationId,
      config,
      rolling,
      modelName: 'Waiting...',
      isAgentActive: false,
      context: {
        used: 0,
        max: MAX_CONTEXT_TOKENS,
        pct: 0,
        compactRecommended: false
      },
      session: {
        input: 0,
        cache: 0,
        output: 0,
        tokens: 0,
        turns: 0,
        models: []
      },
      currentTask: {
        tokens: 0,
        input: 0,
        output: 0,
        turns: 0,
        durationSeconds: 0
      },
      subagents: {
        count: 0,
        activeCount: 0,
        tokens: 0,
        turns: 0
      }
    };
  }

  const knownIds = new Set([conversationId]);
  const subQueue = [];
  for (const cand of main.spawnedCandidates) {
    for (const id of extractSpawnedIds(cand.text, knownIds)) {
      knownIds.add(id);
      subQueue.push(id);
    }
  }

  let subTokens = 0;
  let subInput = 0;
  let subCache = 0;
  let subOutput = 0;
  let subTurns = 0;
  let subActiveCount = 0;
  const sessionModels = {};

  for (const ev of main.events) {
    if (!ev.isModel) continue;
    const tok = ev.input + ev.output;
    if (!sessionModels[ev.model]) {
      sessionModels[ev.model] = { tokens: 0, input: 0, output: 0, turns: 0 };
    }
    sessionModels[ev.model].tokens += tok;
    sessionModels[ev.model].input += ev.input;
    sessionModels[ev.model].output += ev.output;
    sessionModels[ev.model].turns++;
  }

  let idx = 0;
  while (idx < subQueue.length) {
    const subId = subQueue[idx++];
    const subPath = join(BRAIN_DIR, subId, '.system_generated', 'logs', 'transcript.jsonl');
    const sub = parseTranscriptFile(subPath);
    if (!sub) continue;

    subInput += sub.totalInput;
    subCache += sub.totalCacheRead;
    subOutput += sub.totalOutput;
    subTokens += sub.totalInput + sub.totalOutput;
    subTurns += sub.modelTurns;
    if (sub.lastTime && now - sub.lastTime < 10000) {
      subActiveCount++;
    }

    for (const ev of sub.events) {
      if (!ev.isModel) continue;
      const tok = ev.input + ev.output;
      if (!sessionModels[ev.model]) {
        sessionModels[ev.model] = { tokens: 0, input: 0, output: 0, turns: 0 };
      }
      sessionModels[ev.model].tokens += tok;
      sessionModels[ev.model].input += ev.input;
      sessionModels[ev.model].output += ev.output;
      sessionModels[ev.model].turns++;
    }

    for (const cand of sub.spawnedCandidates) {
      for (const deeperId of extractSpawnedIds(cand.text, knownIds)) {
        knownIds.add(deeperId);
        subQueue.push(deeperId);
      }
    }
  }

  let taskInput = 0;
  let taskOutput = 0;
  let taskTurns = 0;
  let taskStart = null;
  let taskEnd = null;
  if (main.lastUserIdx !== -1) {
    for (let i = main.lastUserIdx; i < main.events.length; i++) {
      const ev = main.events[i];
      if (ev.ts) {
        if (taskStart === null) taskStart = ev.ts;
        taskEnd = ev.ts;
      }
      if (ev.isModel) {
        taskInput += ev.input;
        taskOutput += ev.output;
        taskTurns++;
      }
    }
  }

  const isMainActive = main.lastTime !== null && now - main.lastTime < 8000;
  const isAgentActive = isMainActive || subActiveCount > 0;
  const taskDurationSeconds = taskStart
    ? Math.max(1, Math.round(((isAgentActive ? now : (taskEnd || now)) - taskStart) / 1000))
    : 0;

  const contextUsed = main.lastInput + main.lastCacheRead + main.lastOutput;
  const contextPct = Number(((contextUsed / MAX_CONTEXT_TOKENS) * 100).toFixed(1));

  const sessionTotalTokens = main.totalInput + main.totalOutput + subTokens;
  const modelsList = Object.entries(sessionModels)
    .map(([name, s]) => ({
      name,
      tokens: s.tokens,
      input: s.input,
      output: s.output,
      turns: s.turns,
      pct: sessionTotalTokens > 0 ? Number(((s.tokens / sessionTotalTokens) * 100).toFixed(1)) : 0,
      isActive: name === main.activeModel
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    active: true,
    conversationId,
    config,
    rolling,
    modelName: main.activeModel,
    isAgentActive,
    context: {
      used: contextUsed,
      max: MAX_CONTEXT_TOKENS,
      pct: contextPct,
      compactRecommended: contextPct >= config.compactThresholdPct
    },
    session: {
      input: main.totalInput + subInput,
      cache: main.totalCacheRead + subCache,
      output: main.totalOutput + subOutput,
      tokens: sessionTotalTokens,
      turns: main.modelTurns + subTurns,
      models: modelsList
    },
    currentTask: {
      tokens: taskInput + taskOutput,
      input: taskInput,
      output: taskOutput,
      turns: taskTurns,
      durationSeconds: taskDurationSeconds
    },
    subagents: {
      count: subQueue.length,
      activeCount: subActiveCount,
      tokens: subTokens,
      turns: subTurns
    }
  };
}, 'GET');

app.api('/api/config', () => loadConfig(), 'GET');

app.api('/api/config/save', (params) => {
  const cfg = loadConfig();
  if (params.limit5hTokens !== undefined) {
    cfg.limit5hTokens = Math.max(0, Number(params.limit5hTokens) || 0);
  }
  if (params.limit7dTokens !== undefined) {
    cfg.limit7dTokens = Math.max(0, Number(params.limit7dTokens) || 0);
  }
  if (params.compactThresholdPct !== undefined) {
    cfg.compactThresholdPct = Math.min(95, Math.max(10, Number(params.compactThresholdPct) || 65));
  }
  saveConfig(cfg);
  return { success: true, config: cfg };
}, 'GET');

app.run();
