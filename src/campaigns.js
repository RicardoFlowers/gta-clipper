// Lê campaigns.json: campanhas pagas de cortes (quem clipar, legenda obrigatória,
// onde postar, onde enviar o link) + o modo geral (GTA 6 de qualquer streamer).
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'campaigns.json');
const SOURCES = ['twitch', 'kick'];

function toList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [];
}

function num(v, fallback) {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : fallback;
}

function normalizeCampaign(raw, index) {
  const problems = [];
  const id = String(raw.id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) problems.push(`campanha #${index + 1}: "id" precisa ser tipo "clix-gta6"`);
  const source = String(raw.source || 'twitch').toLowerCase();
  if (!SOURCES.includes(source)) problems.push(`${id}: source "${source}" não suportado (use ${SOURCES.join(' ou ')})`);
  const channels = toList(raw.channels);
  if (!channels.length) problems.push(`${id}: "channels" vazio`);
  const since = raw.since ? Date.parse(raw.since) : NaN;
  if (raw.since && !Number.isFinite(since)) problems.push(`${id}: "since" não é uma data válida`);
  const until = raw.until ? Date.parse(raw.until) : NaN;
  if (raw.until && !Number.isFinite(until)) problems.push(`${id}: "until" não é uma data válida`);

  return {
    campaign: {
      id,
      enabled: raw.enabled !== false,
      name: String(raw.name || id),
      source,
      channels,
      since: Number.isFinite(since) ? since : null,
      until: Number.isFinite(until) ? until : null,
      lang: String(raw.lang || 'pt').toLowerCase().startsWith('en') ? 'en' : 'pt',
      maxPerHour: Math.max(0, num(raw.maxPerHour, 3)),
      maxPerRun: Math.max(1, num(raw.maxPerRun, 2)),
      minViews: Math.max(0, num(raw.minViews, 30)),
      maxDuration: num(raw.maxDuration, 60),
      gameOnly: raw.gameOnly === true, // só clipes da categoria do jogo (GAME_NAME)
      lookbackHours: num(raw.lookbackHours, 6),
      mention: String(raw.mention || '').trim(),
      hashtags: String(raw.hashtags || '').trim(),
      disclosure: String(raw.disclosure || '').trim(),
      overlay: String(raw.overlay || '').trim(),
      postWhere: String(raw.postWhere || '').trim(),
      submitUrl: String(raw.submitUrl || '').trim(),
      rulesUrl: String(raw.rulesUrl || '').trim(),
      note: String(raw.note || '').trim(),
    },
    problems,
  };
}

/** Carrega e valida. Arquivo ausente = sem campanhas e modo geral ligado. */
function loadCampaigns(file = DEFAULT_FILE) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { general: { enabled: true, maxPerHour: 0 }, campaigns: [], problems: [] };
    return { general: { enabled: true, maxPerHour: 0 }, campaigns: [], problems: [`campaigns.json inválido: ${e.message}`] };
  }
  const problems = [];
  const campaigns = [];
  const seen = new Set();
  (Array.isArray(raw.campaigns) ? raw.campaigns : []).forEach((c, i) => {
    const { campaign, problems: p } = normalizeCampaign(c || {}, i);
    if (seen.has(campaign.id)) p.push(`id repetido: ${campaign.id}`);
    seen.add(campaign.id);
    if (p.length) problems.push(...p);
    else campaigns.push(campaign);
  });
  const g = raw.general || {};
  return {
    general: { enabled: g.enabled !== false, maxPerHour: Math.max(0, num(g.maxPerHour, 0)) },
    campaigns,
    problems,
  };
}

function isActive(c, now = Date.now()) {
  return c.enabled && (c.until === null || now <= c.until);
}

module.exports = { loadCampaigns, normalizeCampaign, isActive, DEFAULT_FILE };
