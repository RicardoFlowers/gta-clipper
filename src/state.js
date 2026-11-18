const fs = require('fs');

const DAY = 24 * 3600_000;

function emptyState() {
  // log: quando cada clipe saiu, por "fila" (geral ou id da campanha), pro limite por hora
  return { version: 1, clips: {}, log: [], telegramChatId: null, welcomed: false, lastAlert: null };
}

function loadState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyState();
    const clips = data.clips && typeof data.clips === 'object' && !Array.isArray(data.clips) ? data.clips : {};
    const log = Array.isArray(data.log) ? data.log.filter((e) => e && typeof e.k === 'string') : [];
    return { ...emptyState(), ...data, clips, log };
  } catch {
    return emptyState();
  }
}

// Esquece clipes criados há mais de keepMs (bem além da janela de busca)
function prune(state, keepMs, now = Date.now()) {
  for (const [id, entry] of Object.entries(state.clips)) {
    const t = Date.parse(entry && entry.t);
    if (!Number.isFinite(t) || now - t > keepMs) delete state.clips[id];
  }
  state.log = (state.log || []).filter((e) => now - Date.parse(e.at) < DAY);
}

function logSent(state, key, now = Date.now()) {
  state.log = state.log || [];
  state.log.push({ k: key, at: new Date(now).toISOString() });
}

function sentLastHour(state, key, now = Date.now()) {
  return (state.log || []).filter((e) => e.k === key && now - Date.parse(e.at) < 3600_000).length;
}

function saveState(file, state, { lookbackHours = 6, now = Date.now() } = {}) {
  prune(state, Math.max(3 * DAY, (lookbackHours + 24) * 3600_000), now);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

function markOk(state, clip) {
  state.clips[clip.id] = { b: clip.broadcaster_id, t: clip.created_at, ok: true, at: new Date().toISOString() };
}

function markFail(state, clip, reason) {
  const prev = state.clips[clip.id];
  state.clips[clip.id] = {
    b: clip.broadcaster_id,
    t: clip.created_at,
    ok: false,
    fails: ((prev && prev.fails) || 0) + 1,
    err: String(reason || '').slice(0, 200),
  };
}

module.exports = { emptyState, loadState, saveState, prune, markOk, markFail, logSent, sentLastHour };
