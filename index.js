#!/usr/bin/env node
// GTA Clipper: pega clipes da Twitch que estão bombando, converte pra vertical e
// manda pro seu Telegram com a legenda pronta. Duas "filas":
//   - campanhas pagas (campaigns.json): só os streamers da campanha, com a legenda,
//     hashtags e aviso de publicidade que ela exige e o link pra enviar o post
//   - geral: GTA 6 de qualquer streamer (pra crescer perfil)
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
const { loadState, saveState, markOk, markFail, logSent, sentLastHour } = require('./src/state');
const { loadCampaigns, isActive } = require('./src/campaigns');
const {
  telegramCaption,
  postCaption,
  cleanTitle,
  formatViews,
  escapeHtml,
  campaignPostCaption,
  campaignTelegramCaption,
} = require('./src/caption');
const { log, annotate, summary } = require('./src/log');

const ALERT_EVERY_MS = 3 * 3600_000;
const WELCOME =
  '✅ <b>GTA Clipper conectado!</b>\nOs clipes de GTA 6 que estiverem bombando na Twitch vão chegar aqui já na vertical.\nToque no bloco da legenda pra copiar.';

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function slug(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // tira acentos
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

  // Daqui pra baixo qualquer erro do Telegram (fora do ar, bot bloqueado...) só pula a rodada
  try {
    let chatId = cfg.telegramChatId || state.telegramChatId;
    if (!chatId) {
      chatId = await tg.detectChatId();
      if (!chatId) {
        annotate('warning', 'Telegram', `Ainda não sei pra onde mandar: abra o @${me.username} no Telegram e mande /start`);
        return { enabled: true, ready: false };
      }
      state.telegramChatId = chatId;
      log('Telegram conectado'); // sem o id do chat: os logs de repositório público são públicos
    }

    if (!state.welcomed) {
      await tg.sendMessage(chatId, WELCOME);
      state.welcomed = true;
      persist(state);
    }
    return { enabled: true, ready: true, tg, chatId };
  } catch (e) {
    // Chat inválido (bot bloqueado, conversa apagada): esquece o chat salvo pra descobrir de novo no próximo /start
    if (!cfg.telegramChatId && (e.status === 400 || e.status === 403)) {
      state.telegramChatId = null;
      state.welcomed = false;
    }
    annotate('warning', 'Telegram', `Não consegui falar com o Telegram agora (${e.message}). Tento de novo na próxima rodada.`);
    return { enabled: true, ready: false };
  }
}

// Aviso no Telegram, no máximo 1 vez a cada 3h pro mesmo problema
async function alert(telegram, state, key, text) {
  if (!telegram || !telegram.ready) return;
  const last = state.lastAlert;
  if (last && last.msg === key && Date.now() - Date.parse(last.at) < ALERT_EVERY_MS) return;
  try {
    await telegram.tg.sendMessage(telegram.chatId, `⚠️ <b>Clipper com problema</b>\n${escapeHtml(text)}`);
    state.lastAlert = { msg: key, at: new Date().toISOString() };
    persist(state);
  } catch {
    // se nem o alerta sai, fica só no log
  }
}

// ---------- perfis: como um clipe vira vídeo + legenda ----------

function generalProfile() {
  return {
    key: 'geral',
    label: 'Geral',
    overlay: (clip, login) => `twitch.tv/${login}`,
    topText: null,
    postCaption: (clip, login) => postCaption(clip, login, cfg.hashtags),
    telegramCaption: (clip, login) => telegramCaption(clip, login, cfg.hashtags),
  };
}

function campaignProfile(camp) {
  const site = camp.source === 'kick' ? 'kick.com' : 'twitch.tv';
  return {
    key: camp.id,
    label: camp.name,
    overlay: (clip, login) => camp.overlay || `${site}/${login}`,
    topText: camp.disclosure || null,
    postCaption: (clip, login) => campaignPostCaption(clip, login, camp),
    telegramCaption: (clip, login) => campaignTelegramCaption(clip, login, camp),
  };
}

async function processClip(clip, login, telegram, profile) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  // o id no fim evita que dois clipes com o mesmo título (o título padrão é o da live) se sobrescrevam
  const name = `${stamp}_${slug(profile.key)}_${slug(login)}_${slug(cleanTitle(clip.title))}_${slug(clip.id).slice(-8)}`;
  const dir = path.join(cfg.outDir, name);
  const raw = path.join(cfg.tmpDir, `${slug(clip.id)}.mp4`);
  const video = path.join(dir, 'video.mp4');
  let produced = false;

  try {
    await download(clip.url, raw);
    fs.mkdirSync(dir, { recursive: true });
    const { bytes, fontMissing } = await toVertical(raw, video, {
      creditText: profile.overlay(clip, login),
      topText: profile.topText,
      fontFile: cfg.fontFile,
    });
    produced = true;
    if (fontMissing) annotate('warning', 'Fonte', `FONT_FILE não encontrado (${cfg.fontFile}), vídeo saiu sem texto escrito`);

    fs.writeFileSync(path.join(dir, 'legenda.txt'), profile.postCaption(clip, login));
    fs.writeFileSync(
      path.join(dir, 'info.json'),
      JSON.stringify(
        {
          fila: profile.label,
          streamer: clip.broadcaster_name,
          login,
          titulo: clip.title,
          views: clip.view_count,
          idioma: clip.language,
          criado_em: clip.created_at,
          url: clip.url,
        },
        null,
        2
      )
    );

    if (telegram.ready) {
      await telegram.tg.sendVideo(telegram.chatId, video, {
        caption: profile.telegramCaption(clip, login),
        width: 1080,
        height: 1920,
        duration: clip.duration,
      });
    }
    return { dir: name, mb: (bytes / 1048576).toFixed(1) };
  } catch (e) {
    // Vídeo pronto que só não chegou no Telegram fica na pasta (vai pro backup do GitHub);
    // pasta pela metade (download/conversão falhou) é apagada
    if (!produced) fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

// Quantos ainda cabem nesta hora (maxPerHour 0 = sem limite por hora)
function remainingThisHour(state, key, maxPerHour) {
  if (!maxPerHour) return Infinity;
  return Math.max(0, maxPerHour - sentLastHour(state, key));
}

async function processQueue(run, picked, profile, loginFor) {
  for (const clip of picked) {
    const login = loginFor(clip.broadcaster_id) || String(clip.broadcaster_name || '').toLowerCase();
    log(`▶ [${profile.key}] ${clip.broadcaster_name}: "${cleanTitle(clip.title)}" (${clip.view_count} views, ${Math.round(clip.duration)}s, ${clip.language})`);
    run.attempted++;
    try {
      const r = await processClip(clip, login, run.telegram, profile);
      markOk(run.state, clip);
      logSent(run.state, profile.key);
      run.sent++;
      log(`  ✔ pronto (${r.mb} MB)${run.telegram.ready ? ' e enviado pro Telegram' : ''}`);
      run.rows.push(`| ✅ | ${profile.label} | ${clip.broadcaster_name} | ${formatViews(clip.view_count)} | ${cleanTitle(clip.title).replace(/\|/g, '/')} |`);
    } catch (e) {
      markFail(run.state, clip, e.message);
      run.firstError = run.firstError || e.message;
      annotate('warning', `Falhou: ${clip.broadcaster_name}`, e.message);
      run.rows.push(`| ❌ | ${profile.label} | ${clip.broadcaster_name} | ${formatViews(clip.view_count)} | ${e.message.slice(0, 120).replace(/\|/g, '/')} |`);
    }
    persist(run.state);
  }
}

async function runCampaigns(ctx, run, campaigns) {
  const twitchCamps = campaigns.filter((c) => c.source === 'twitch');
  for (const c of campaigns.filter((x) => x.source !== 'twitch')) {
    annotate('notice', 'Campanha pulada', `${c.name}: clipes da ${c.source} ainda não são suportados`);
  }
  const channelIds = new Set();
  if (!twitchCamps.length) return channelIds;

  ctx.users = ctx.users || new Map();
  const missing = [...new Set(twitchCamps.flatMap((c) => c.channels))].filter((l) => !ctx.users.has(l));
  if (missing.length) {
    const found = await ctx.twitch.getUsersByLogin(missing);
    for (const [login, u] of found) ctx.users.set(login, u);
    for (const l of missing) if (!found.has(l)) annotate('warning', 'Campanha', `canal "${l}" não existe na Twitch; confira campaigns.json`);
  }

  for (const camp of twitchCamps) {
    const users = camp.channels.map((l) => ctx.users.get(l)).filter(Boolean);
    users.forEach((u) => channelIds.add(u.id));
    const remaining = remainingThisHour(run.state, camp.id, camp.maxPerHour);
    if (!users.length) continue;
    if (remaining === 0) {
      log(`[${camp.id}] limite de ${camp.maxPerHour}/hora atingido, fica pra próxima`);
      continue;
    }
    let clips = [];
    for (const u of users) clips.push(...(await ctx.twitch.getChannelClips(u.id, camp.lookbackHours, { sinceMs: camp.since || 0 })));
    if (camp.since) clips = clips.filter((c) => Date.parse(c.created_at) >= camp.since);
    const picked = selectClips(clips, run.state, {
      minViews: camp.minViews,
      maxDuration: camp.maxDuration,
      languages: [],
      boostLang: '',
      boost: 1,
      clipsPerRun: Math.min(camp.maxPerRun, remaining),
      maxPerStreamer: 0,
    });
    log(`[${camp.id}] ${clips.length} clipes dos canais da campanha, ${picked.length} escolhidos`);
    const byId = new Map(users.map((u) => [u.id, u.login]));
    await processQueue(run, picked, campaignProfile(camp), (id) => byId.get(id));
  }
  return channelIds;
}

async function runGeneral(ctx, run, general, excludeIds) {
  const remaining = remainingThisHour(run.state, 'geral', general.maxPerHour);
  if (remaining === 0) {
    log(`[geral] limite de ${general.maxPerHour}/hora atingido, fica pra próxima`);
    return;
  }
  if (!ctx.game) {
    ctx.game = await ctx.twitch.findGame(cfg.gameName);
    log(`Categoria: ${ctx.game.name} (id ${ctx.game.id})`);
    if (normName(ctx.game.name) !== normName(cfg.gameName))
      annotate('warning', 'Categoria', `"${cfg.gameName}" não existe com esse nome na Twitch; usando "${ctx.game.name}". Confira GAME_NAME.`);
  }
  // Streamers de campanha ficam só na fila da campanha (com a legenda certa)
  const clips = (await ctx.twitch.getClips(ctx.game.id, cfg.lookbackHours)).filter((c) => !excludeIds.has(c.broadcaster_id));
  const picked = selectClips(clips, run.state, { ...cfg, clipsPerRun: Math.min(cfg.clipsPerRun, remaining) });
  log(`${clips.length} clipes nas últimas ${cfg.lookbackHours}h, ${picked.length} escolhidos nesta rodada`);
  run.found += clips.length;
  if (!picked.length) return;

  let logins = new Map();
  try {
    logins = await ctx.twitch.getLogins(picked.map((c) => c.broadcaster_id));
  } catch (e) {
    annotate('warning', 'Twitch', `Não consegui buscar os logins dos streamers: ${e.message}`);
  }
  await processQueue(run, picked, generalProfile(), (id) => logins.get(id));
}

async function runOnce(ctx) {
  const state = loadState(cfg.stateFile);
  const telegram = await setupTelegram(state);
  persist(state);
  if (telegram.enabled && !telegram.ready) return { sent: 0, skipped: 'telegram' };

  const { general, campaigns, problems } = loadCampaigns(cfg.campaignsFile);
  for (const p of problems) annotate('warning', 'campaigns.json', p);
  const active = campaigns.filter((c) => isActive(c));

  const run = { state, telegram, rows: [], sent: 0, attempted: 0, found: 0, firstError: null };
  try {
    // Campanhas primeiro: são as que pagam
    const campaignChannels = await runCampaigns(ctx, run, active);
    if (general.enabled) await runGeneral(ctx, run, general, campaignChannels);

    if (!run.attempted) {
      summary('Nenhum clipe novo nesta rodada.');
      return { sent: 0, found: run.found };
    }
    annotate('notice', 'Rodada', `${run.sent} de ${run.attempted} clipes ${telegram.ready ? 'enviados pro Telegram' : 'gerados'}`);
    summary(['| | Fila | Streamer | Views | Título |', '|---|---|---|---|---|', ...run.rows].join('\n'));

    // Se nenhum clipe saiu (ex.: a Twitch mudou algo e o yt-dlp quebrou), avisa em vez de ficar mudo
    if (run.sent === 0 && run.firstError) {
      await alert(telegram, state, `todos falharam: ${run.firstError.slice(0, 120)}`,
        `Nenhum dos ${run.attempted} clipes escolhidos saiu nesta rodada.\nPrimeiro erro: ${run.firstError.slice(0, 500)}`);
    }
    return { sent: run.sent, found: run.found };
  } catch (e) {
    annotate('error', 'Erro na rodada', e.message);
    await alert(telegram, state, e.message, e.message);
    return { sent: run.sent, error: e.message };
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
  await ctx.twitch.revoke().catch(() => {}); // melhor esforço
}

main().catch((e) => {
  annotate('error', 'Falha geral', e.message);
  process.exit(1);
});
