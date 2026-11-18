const path = require('path');

const ROOT = path.join(__dirname, '..');

// Carrega o .env se existir (Node 20.12+). No GitHub Actions as variáveis vêm dos secrets.
function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (typeof process.loadEnvFile !== 'function') return;
  try {
    process.loadEnvFile(file);
  } catch {
    // sem .env, tudo bem
  }
}

function num(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value, fallback) {
  const v = (value ?? '').toString().trim();
  return v || fallback;
}

// "pt,en" -> ['pt','en'] | "all" -> [] (todos) | vazio -> padrão
function langList(value, fallback) {
  const raw = (value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'all' || raw === '*' || raw === 'todos') return [];
  return raw
    .split(',')
    .map((s) => s.trim().split(/[-_]/)[0])
    .filter(Boolean);
}

function readConfig(env = process.env) {
  const boostRaw = (env.BOOST_LANG || '').trim().toLowerCase();
  return {
    clientId: str(env.TWITCH_CLIENT_ID, ''),
    clientSecret: str(env.TWITCH_CLIENT_SECRET, ''),
    gameName: str(env.GAME_NAME, 'Grand Theft Auto VI'),

    languages: langList(env.LANGUAGES, ['pt', 'en']),
    boostLang: !boostRaw ? 'pt' : boostRaw === 'none' ? '' : boostRaw.split(/[-_]/)[0],
    boost: num(env.BOOST, 3),
    lookbackHours: num(env.LOOKBACK_HOURS, 6),
    minViews: num(env.MIN_VIEWS, 50),
    maxDuration: num(env.MAX_DURATION, 60),
    clipsPerRun: num(env.CLIPS_PER_RUN, 3),
    maxPerStreamer: num(env.MAX_PER_STREAMER, 1),
    intervalMin: num(env.INTERVAL_MIN, 10),

    fontFile: str(env.FONT_FILE, ''),
    hashtags: str(env.HASHTAGS, '#GTA6 #GTAVI #GTA6Brasil #gta #twitch #clips'),

    telegramToken: str(env.TELEGRAM_BOT_TOKEN, ''),
    telegramChatId: str(env.TELEGRAM_CHAT_ID, ''),

    campaignsFile: path.resolve(ROOT, str(env.CAMPAIGNS_FILE, 'campaigns.json')),
    stateFile: path.resolve(ROOT, str(env.STATE_FILE, 'state.json')),
    outDir: path.resolve(ROOT, str(env.OUTPUT_DIR, 'output')),
    tmpDir: path.resolve(ROOT, str(env.TMP_DIR, 'tmp')),

    // Só pra testes (apontar pra servidores simulados)
    twitchApiBase: str(env.TWITCH_API_BASE, 'https://api.twitch.tv/helix'),
    twitchAuthUrl: str(env.TWITCH_AUTH_URL, 'https://id.twitch.tv/oauth2/token'),
    telegramApiBase: str(env.TELEGRAM_API_BASE, 'https://api.telegram.org'),
    kickBase: str(env.KICK_BASE, 'https://kick.com'),
  };
}

module.exports = { loadDotEnv, readConfig, ROOT };
