// Escolhe quais clipes processar nesta rodada.

const DUP_WINDOW_MS = 90_000; // clipes do mesmo streamer criados com até 90s de diferença = mesmo momento
const MAX_FAILS = 2;

function baseLang(lang) {
  return String(lang || '').toLowerCase().split(/[-_]/)[0];
}

// Views por hora "amortecido": valoriza clipe que está bombando agora sem
// ignorar os que já têm muita view. Idioma prioritário ganha multiplicador.
function score(clip, cfg, now = Date.now()) {
  const created = Date.parse(clip.created_at);
  const ageHours = Number.isFinite(created) ? Math.max(0, (now - created) / 3600_000) : 24;
  let s = (clip.view_count || 0) / Math.pow(ageHours + 1, 0.8);
  if (cfg.boostLang && baseLang(clip.language) === cfg.boostLang) s *= cfg.boost || 1;
  return s;
}

function isEligible(clip, state, cfg) {
  const prev = state.clips[clip.id];
  if (prev && (prev.ok || (prev.fails || 0) >= MAX_FAILS)) return false;
  if (!(clip.view_count >= cfg.minViews)) return false;
  if (!(clip.duration <= cfg.maxDuration + 0.5)) return false;
  if (cfg.languages.length && !cfg.languages.includes(baseLang(clip.language))) return false;
  return true;
}

function sameMoment(a, b) {
  if (!a.b || a.b !== b.b) return false;
  const ta = Date.parse(a.t);
  const tb = Date.parse(b.t);
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= DUP_WINDOW_MS;
}

function selectClips(clips, state, cfg, now = Date.now()) {
  const sent = Object.values(state.clips).filter((e) => e && e.ok);
  const ranked = clips
    .filter((c) => isEligible(c, state, cfg))
    .map((c) => ({ c, s: score(c, cfg, now) }))
    .sort((x, y) => y.s - x.s);

  const picked = [];
  const perStreamer = new Map();

  for (const { c } of ranked) {
    if (picked.length >= cfg.clipsPerRun) break;
    const n = perStreamer.get(c.broadcaster_id) || 0;
    if (cfg.maxPerStreamer > 0 && n >= cfg.maxPerStreamer) continue;

    const me = { b: c.broadcaster_id, t: c.created_at };
    if (sent.some((e) => sameMoment(e, me))) continue;
    if (picked.some((p) => p.id === c.id || sameMoment({ b: p.broadcaster_id, t: p.created_at }, me))) continue;

    picked.push(c);
    perStreamer.set(c.broadcaster_id, n + 1);
  }
  return picked;
}

module.exports = { selectClips, score, isEligible, sameMoment, baseLang, DUP_WINDOW_MS, MAX_FAILS };
