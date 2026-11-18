#!/usr/bin/env node
// GTA Clipper: pega os clipes de GTA VI que estão bombando na Twitch,
// converte pra vertical e manda pro seu Telegram com a legenda pronta.
//
//   node index.js          fica rodando (a cada INTERVAL_MIN minutos)
//   node index.js --once   roda uma vez (é assim que o GitHub Actions usa)

const fs = require('fs');
const path = require('path');
const { loadDotEnv, readConfig } = require('./src/config');

loadDotEnv();
const cfg = readConfig();

const { createTwitch } = require('./src/twitch');
const { createTelegram } = require('./src/telegram');
const { checkTools, download, toVertical } = require('./src/video');
const { selectClips } = require('./src/select');
const { loadState, saveState, markOk, markFail } = require('./src/state');
const { telegramCaption, postCaption, cleanTitle, formatViews } = require('./src/caption');
const { log, annotate, summary } = require('./src/log');

const ALERT_EVERY_MS = 3 * 3600_000;

function slug(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'clipe';
}

function persist(state) {
  saveState(cfg.stateFile, state, { lookbackHours: cfg.lookbackHours });
}

// Prepara o Telegram. Se o token existe mas ainda não dá pra enviar, a rodada é pulada
// (assim nenhum clipe é marcado como enviado sem ter chegado no seu celular).
async function setupTelegram(state) {
  if (!cfg.telegramToken) return { enabled: false };
  const tg = createTelegram({ token: cfg.telegramToken, apiBase: cfg.telegramApiBase });

  let me;
  try {
    me = await tg.getMe();
  } catch (e) {
    annotate('error', 'Telegram', `O token do bot não funcionou (${e.message}). Confira o secret TELEGRAM_BOT_TOKEN.`);
    return { enabled: true, ready: false };
  }

  let chatId = cfg.telegramChatId || state.telegramChatId;
  if (!chatId) {
    chatId = await tg.detectChatId();
    if (!chatId) {
      annotate('warning', 'Telegram', `Ainda não sei pra onde mandar: abra o @${me.username} no Telegram e mande /start`);
      return { enabled: true, ready: false };
    }
    state.telegramChatId = chatId;
    log(`Telegram conectado (chat ${chatId})`);
  }

  if (!state.welcomed) {
    await tg.sendMessage(
      chatId,
      '✅ <b>GTA Clipper conectado!</b>\nOs clipes de GTA 6 que estiverem bombando na Twitch vão chegar aqui já na vertical.\nToque no bloco da legenda pra copiar.'
    );
    state.welcomed = true;
    persist(state);
  }
  return { enabled: true, ready: true, tg, chatId };
}

async function alert(telegram, state, message) {
  if (!telegram || !telegram.ready) return;
  const last = state.lastAlert;
  if (last && last.msg === message && Date.now() - Date.parse(last.at) < ALERT_EVERY_MS) return;
  try {
    await telegram.tg.sendMessage(telegram.chatId, `⚠️ <b>Clipper com problema</b>\n${message.replace(/[<>&]/g, '')}`);
    state.lastAlert = { msg: message, at: new Date().toISOString() };
    persist(state);
  } catch {
    // se nem o alerta sai, fica só no log
  }
}

async function processClip(clip, login, telegram) {
  const name = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}_${slug(login)}_${slug(cleanTitle(clip.title))}`;
  const dir = path.join(cfg.outDir, name);
  const raw = path.join(cfg.tmpDir, `${slug(clip.id)}.mp4`);
  const video = path.join(dir, 'video.mp4');

  try {
    await download(clip.url, raw);
    fs.mkdirSync(dir, { recursive: true });
    const { bytes, fontMissing } = await toVertical(raw, video, {
      creditText: `twitch.tv/${login}`,
      fontFile: cfg.fontFile,
    });
    if (fontMissing) annotate('warning', 'Fonte', `FONT_FILE não encontrado (${cfg.fontFile}), vídeo saiu sem o crédito escrito`);

    fs.writeFileSync(path.join(dir, 'legenda.txt'), postCaption(clip, login, cfg.hashtags));
    fs.writeFileSync(
      path.join(dir, 'info.json'),
      JSON.stringify(
        { streamer: clip.broadcaster_name, login, titulo: clip.title, views: clip.view_count, idioma: clip.language, criado_em: clip.created_at, url: clip.url },
        null,
        2
      )
    );

    if (telegram.ready) {
      await telegram.tg.sendVideo(telegram.chatId, video, {
        caption: telegramCaption(clip, login, cfg.hashtags),
        width: 1080,
        height: 1920,
        duration: clip.duration,
      });
    }
    return { dir: name, mb: (bytes / 1048576).toFixed(1) };
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

async function runOnce(ctx) {
  const state = loadState(cfg.stateFile);
  const telegram = await setupTelegram(state);
  persist(state);
  if (telegram.enabled && !telegram.ready) return { sent: 0, skipped: 'telegram' };

  try {
    if (!ctx.game) {
      ctx.game = await ctx.twitch.findGame(cfg.gameName);
      log(`Categoria: ${ctx.game.name} (id ${ctx.game.id})`);
    }
    const clips = await ctx.twitch.getClips(ctx.game.id, cfg.lookbackHours);
    const picked = selectClips(clips, state, cfg);
    log(`${clips.length} clipes nas últimas ${cfg.lookbackHours}h, ${picked.length} escolhidos nesta rodada`);

    if (!picked.length) {
      summary(`Nenhum clipe novo nesta rodada (${clips.length} clipes encontrados na janela).`);
      return { sent: 0, found: clips.length };
    }

    let logins = new Map();
    try {
      logins = await ctx.twitch.getLogins(picked.map((c) => c.broadcaster_id));
    } catch (e) {
      annotate('warning', 'Twitch', `Não consegui buscar os logins dos streamers: ${e.message}`);
    }

    const rows = [];
    let sent = 0;
    for (const clip of picked) {
      const login = logins.get(clip.broadcaster_id) || String(clip.broadcaster_name || '').toLowerCase();
      log(`▶ ${clip.broadcaster_name}: "${cleanTitle(clip.title)}" (${clip.view_count} views, ${Math.round(clip.duration)}s, ${clip.language})`);
      try {
        const r = await processClip(clip, login, telegram);
        markOk(state, clip);
        sent++;
        log(`  ✔ pronto (${r.mb} MB)${telegram.ready ? ' e enviado pro Telegram' : ''}`);
        rows.push(`| ✅ | ${clip.broadcaster_name} | ${formatViews(clip.view_count)} | ${clip.language} | ${cleanTitle(clip.title).replace(/\|/g, '/')} |`);
      } catch (e) {
        markFail(state, clip, e.message);
        annotate('warning', `Falhou: ${clip.broadcaster_name}`, e.message);
        rows.push(`| ❌ | ${clip.broadcaster_name} | ${formatViews(clip.view_count)} | ${clip.language} | ${e.message.slice(0, 120).replace(/\|/g, '/')} |`);
      }
      persist(state);
    }

    annotate('notice', 'Rodada', `${sent} de ${picked.length} clipes ${telegram.ready ? 'enviados pro Telegram' : 'gerados'} (${clips.length} na janela)`);
    summary(['| | Streamer | Views | Idioma | Título |', '|---|---|---|---|---|', ...rows].join('\n'));
    return { sent, found: clips.length };
  } catch (e) {
    annotate('error', 'Erro na rodada', e.message);
    await alert(telegram, state, e.message);
    return { sent: 0, error: e.message };
  } finally {
    persist(state);
  }
}

async function main() {
  const once = process.argv.includes('--once');

  const missing = [!cfg.clientId && 'TWITCH_CLIENT_ID', !cfg.clientSecret && 'TWITCH_CLIENT_SECRET'].filter(Boolean);
  if (missing.length) {
    annotate('warning', 'Configuração', `Falta ${missing.join(' e ')} (no GitHub: Settings > Secrets and variables > Actions)`);
    process.exit(once ? 0 : 1);
  }

  await checkTools();
  fs.mkdirSync(cfg.outDir, { recursive: true });
  fs.mkdirSync(cfg.tmpDir, { recursive: true });
  fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });

  const ctx = {
    twitch: createTwitch({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      apiBase: cfg.twitchApiBase,
      authUrl: cfg.twitchAuthUrl,
    }),
  };

  for (;;) {
    await runOnce(ctx);
    if (once) break;
    log(`Próxima busca em ${cfg.intervalMin} min (Ctrl+C pra parar)\n`);
    await new Promise((r) => setTimeout(r, cfg.intervalMin * 60_000));
  }
}

main().catch((e) => {
  annotate('error', 'Falha geral', e.message);
  process.exit(1);
});
