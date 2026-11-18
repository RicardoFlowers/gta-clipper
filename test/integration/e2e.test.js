// Rodada completa: index.js de verdade, com Twitch e Telegram simulados,
// yt-dlp e ffmpeg de verdade baixando de um servidor local.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { startServer, json, parseForm, parseJson, hasBin, makeVideo, probe, serveDir } = require('../helpers/mock');

const SKIP = (!hasBin('ffmpeg') || !hasBin('yt-dlp')) && 'precisa de ffmpeg e yt-dlp';
const ROOT = path.join(__dirname, '..', '..');
const TOKEN = '999:BOT-TOKEN';
const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60_000).toISOString();

const media = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-media-'));
if (!SKIP) {
  makeVideo(path.join(media, 'a.mp4'), { seconds: 2 });
  makeVideo(path.join(media, 'b.mp4'), { w: 1920, h: 1080, fps: 60, seconds: 2 });
  makeVideo(path.join(media, 'c.mp4'), { seconds: 2, audio: false });
}

// O "mundo" simulado: Twitch, Telegram e arquivos, num servidor só
function world({ clips, channelClips = {}, users = {}, kick = {}, updates = [{ update_id: 1, message: { chat: { id: 777, type: 'private' }, text: '/start' } }], twitchDown = false, fail = {} }) {
  // fail: { getUpdates: [status, descrição], sendMessage: [...], sendVideo: [...] } simula erros do Telegram
  // channelClips: { broadcaster_id: [clipes] } (campanhas) | users: { login: broadcaster_id }
  const w = { clips, channelClips, users, kick, updates, twitchDown, fail, videos: [], messages: [], downloads: 0, revoked: 0, clipQueries: [] };
  const files = serveDir(media);
  w.handler = async (req, res) => {
    if (req.path.startsWith('/media/')) {
      w.downloads++;
      return files(req, res);
    }
    if (req.path === '/oauth2/token') return json(res, 200, { access_token: 't', expires_in: 9999 });
    if (req.path === '/oauth2/revoke') {
      w.revoked++;
      return json(res, 200, {});
    }
    const kickMatch = req.path.match(/^\/api\/v2\/channels\/([^/]+)\/clips$/);
    if (kickMatch) {
      if (!w.kick[kickMatch[1]]) return json(res, 404, { message: 'Channel not found' });
      const list = w.kick[kickMatch[1]].map((c) => ({ ...c, clip_url: `${w.base}/media/${c.file}` }));
      return req.query.get('sort') === 'view' ? json(res, 200, { clips: list, nextCursor: null }) : json(res, 200, { clips: [], nextCursor: null });
    }
    if (req.path.startsWith('/helix/')) {
      if (w.twitchDown) return json(res, 503, { message: 'Service Unavailable' });
      const p = req.path.slice(7);
      if (p === 'games') return json(res, 200, { data: [{ id: '42', name: 'Grand Theft Auto VI' }] });
      if (p === 'clips') {
        w.clipQueries.push(Object.fromEntries(req.query));
        const b = req.query.get('broadcaster_id');
        const list = b ? w.channelClips[b] || [] : w.clips;
        return json(res, 200, { data: list.map((c) => ({ ...c, url: `${w.base}/media/${c.file}` })), pagination: {} });
      }
      if (p === 'users') {
        const logins = req.query.getAll('login');
        if (logins.length)
          return json(res, 200, { data: logins.filter((l) => w.users[l]).map((l) => ({ id: w.users[l], login: l, display_name: l })) });
        return json(res, 200, { data: req.query.getAll('id').map((id) => ({ id, login: `login_${id}` })) });
      }
    }
    const m = req.path.match(/^\/bot([^/]+)\/(\w+)$/);
    if (m) {
      if (m[1] !== TOKEN) return json(res, 401, { ok: false, description: 'Unauthorized' });
      const injected = w.fail[m[2]];
      if (injected) return json(res, injected[0], { ok: false, error_code: injected[0], description: injected[1] });
      if (m[2] === 'getMe') return json(res, 200, { ok: true, result: { username: 'meu_clipper_bot' } });
      if (m[2] === 'getUpdates') return json(res, 200, { ok: true, result: w.updates });
      if (m[2] === 'sendMessage') {
        w.messages.push(parseJson(req));
        return json(res, 200, { ok: true, result: {} });
      }
      if (m[2] === 'sendVideo') {
        const form = await parseForm(req);
        const video = form.get('video');
        const file = path.join(media, `recebido-${w.videos.length}.mp4`);
        fs.writeFileSync(file, Buffer.from(await video.arrayBuffer()));
        w.videos.push({ chat: form.get('chat_id'), caption: form.get('caption'), file });
        return json(res, 200, { ok: true, result: {} });
      }
    }
    return json(res, 404, { message: `rota ${req.path}` });
  };
  return w;
}

function clip(id, b, { views = 200, lang = 'pt', min = 20, file = 'a.mp4', title = `Clipe ${id} !pix` } = {}) {
  return { id, broadcaster_id: b, broadcaster_name: `Streamer${b}`, language: lang, title, view_count: views, duration: 2, created_at: ago(min), file };
}

function runClipper(env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'index.js'), '--once'],
      { env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '', TELEGRAM_CHAT_ID: '', ...env }, timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr })
    );
  });
}

async function setup(t, opts) {
  const w = world(opts);
  const srv = await startServer(w.handler);
  w.base = srv.url;
  t.after(srv.close);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-run-'));
  const env = {
    TWITCH_CLIENT_ID: 'id',
    TWITCH_CLIENT_SECRET: 'secret',
    TWITCH_API_BASE: `${srv.url}/helix`,
    TWITCH_AUTH_URL: `${srv.url}/oauth2/token`,
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_API_BASE: srv.url,
    STATE_FILE: path.join(work, 'state.json'),
    OUTPUT_DIR: path.join(work, 'output'),
    TMP_DIR: path.join(work, 'tmp'),
    FONT_FILE: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    CAMPAIGNS_FILE: path.join(work, 'sem-campanhas.json'),
    KICK_BASE: srv.url,
    ...(opts.env || {}),
  };
  const state = () => JSON.parse(fs.readFileSync(env.STATE_FILE, 'utf8'));
  return { w, env, work, state };
}

test('rodada completa: escolhe, converte, envia, e não repete na próxima', { skip: SKIP }, async (t) => {
  const { w, env, work, state } = await setup(t, {
    clips: [
      clip('pt1', 'A', { views: 500, min: 10 }),
      clip('pt1-dup', 'A', { views: 300, min: 9.5 }), // mesmo momento, outra pessoa clipou
      clip('en1', 'B', { views: 3000, lang: 'en', min: 120, file: 'b.mp4' }),
      clip('es1', 'C', { views: 9000, lang: 'es' }), // idioma fora do filtro
      clip('fraco', 'D', { views: 5 }), // poucas views
      clip('en2', 'E', { views: 400, lang: 'en', min: 30, file: 'c.mp4' }),
      clip('pt2', 'A', { views: 250, min: 70 }), // mesmo streamer, outro momento: fica pra próxima rodada
    ],
  });

  const r1 = await runClipper(env);
  assert.equal(r1.code, 0, r1.out);
  assert.equal(w.messages.length, 1, 'mensagem de boas-vindas');
  assert.match(w.messages[0].text, /conectado/);
  assert.equal(w.messages[0].chat_id, 777);
  assert.equal(w.videos.length, 3, r1.out);

  const sentIds = Object.entries(state().clips).filter(([, e]) => e.ok).map(([id]) => id).sort();
  assert.deepEqual(sentIds, ['en1', 'en2', 'pt1']);
  for (const v of w.videos) {
    assert.equal(v.chat, '777');
    assert.match(v.caption, /<code>[\s\S]*twitch\.tv\/login_[ABE][\s\S]*#GTA6[\s\S]*<\/code>/);
    assert.doesNotMatch(v.caption, /!pix/);
    const p = probe(v.file);
    assert.equal(p.width, 1080);
    assert.equal(p.height, 1920);
  }
  assert.equal(state().telegramChatId, 777);
  assert.equal(state().welcomed, true);

  const folders = fs.readdirSync(env.OUTPUT_DIR);
  assert.equal(folders.length, 3);
  for (const f of folders) {
    for (const file of ['video.mp4', 'legenda.txt', 'info.json']) assert.ok(fs.existsSync(path.join(env.OUTPUT_DIR, f, file)), `${f}/${file}`);
  }
  assert.deepEqual(fs.readdirSync(env.TMP_DIR), [], 'tmp limpo');

  // Rodada 2: só o pt2 (o streamer A liberou), sem boas-vindas de novo
  w.updates = []; // o /start some do getUpdates depois de 24h: o chat salvo tem que bastar
  const r2 = await runClipper(env);
  assert.equal(r2.code, 0, r2.out);
  assert.equal(w.messages.length, 1);
  assert.equal(w.videos.length, 4, r2.out);
  assert.ok(state().clips.pt2.ok);

  // Rodada 3: nada novo
  const r3 = await runClipper(env);
  assert.equal(r3.code, 0, r3.out);
  assert.equal(w.videos.length, 4);
  assert.match(r3.out, /0 escolhidos/);

  // nada de id do chat nos logs (no GitHub, log de repositório público é público)
  for (const out of [r1.out, r2.out, r3.out]) assert.doesNotMatch(out, /777/);
  // o token da Twitch é revogado no fim de cada rodada
  assert.equal(w.revoked, 3);
  fs.rmSync(work, { recursive: true, force: true });
});

test('Telegram fora do ar no começo da rodada: não derruba o processo, só pula a rodada', { skip: SKIP }, async (t) => {
  const { w, env, state } = await setup(t, { clips: [clip('x', 'A')], fail: { getUpdates: [502, 'Bad Gateway'] } });
  const r = await runClipper(env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Não consegui falar com o Telegram agora/);
  assert.equal(w.downloads, 0);
  assert.deepEqual(state().clips, {});
});

test('bot bloqueado na mensagem de boas-vindas: esquece o chat pra descobrir de novo no próximo /start', { skip: SKIP }, async (t) => {
  const { w, env, state } = await setup(t, { clips: [clip('x', 'A')], fail: { sendMessage: [403, 'Forbidden: bot was blocked by the user'] } });
  const r = await runClipper(env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /blocked/);
  assert.equal(state().telegramChatId, null);
  assert.equal(state().welcomed, false);
  assert.equal(w.downloads, 0);

  delete w.fail.sendMessage; // desbloqueou e mandou /start de novo
  const r2 = await runClipper(env);
  assert.equal(r2.code, 0, r2.out);
  assert.equal(state().welcomed, true);
  assert.equal(w.videos.length, 1);
});

test('nenhum clipe saiu: avisa no Telegram (uma vez só pro mesmo erro) e guarda o vídeo pronto no backup', { skip: SKIP }, async (t) => {
  const { w, env, state } = await setup(t, {
    clips: [clip('a', 'A'), clip('b', 'B', { file: 'b.mp4' })],
    fail: { sendVideo: [413, 'Request Entity Too Large'] },
  });
  await runClipper(env);
  const alerts = () => w.messages.filter((m) => /problema/.test(m.text));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].text, /Nenhum dos 2 clipes[\s\S]*Request Entity Too Large/);
  assert.equal(state().clips.a.fails, 1);
  // o vídeo foi convertido, só não chegou: fica na pasta pro backup do GitHub
  const folders = fs.readdirSync(env.OUTPUT_DIR);
  assert.equal(folders.length, 2);
  for (const f of folders) assert.ok(fs.existsSync(path.join(env.OUTPUT_DIR, f, 'video.mp4')));

  await runClipper(env); // falha igual de novo: não repete o aviso
  assert.equal(alerts().length, 1);
  assert.equal(state().clips.a.fails, 2);
});

test('download quebrado não deixa pasta pela metade', { skip: SKIP }, async (t) => {
  const { env } = await setup(t, { clips: [clip('sumiu', 'A', { file: 'nao-existe.mp4' })] });
  await runClipper(env);
  assert.deepEqual(fs.readdirSync(env.OUTPUT_DIR), []);
});

test('dois clipes do mesmo streamer com o mesmo título não se sobrescrevem', { skip: SKIP }, async (t) => {
  const { w, env } = await setup(t, {
    clips: [clip('m1', 'A', { title: 'GTA 6 DIA 1', min: 10 }), clip('m2', 'A', { title: 'GTA 6 DIA 1', min: 40, file: 'b.mp4' })],
    env: { MAX_PER_STREAMER: '0' },
  });
  await runClipper(env);
  assert.equal(w.videos.length, 2);
  assert.equal(fs.readdirSync(env.OUTPUT_DIR).length, 2);
});

test('nome de categoria aproximado gera aviso', { skip: SKIP }, async (t) => {
  const { env } = await setup(t, { clips: [], env: { GAME_NAME: 'GTA 6' } });
  const r = await runClipper(env);
  assert.match(r.out, /"GTA 6" não existe com esse nome/);
});

test('sem /start no bot: não baixa nada, não marca nada e explica o que fazer', { skip: SKIP }, async (t) => {
  const { w, env, state } = await setup(t, { clips: [clip('x', 'A')], updates: [] });
  const r = await runClipper(env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /@meu_clipper_bot.*\/start/);
  assert.equal(w.downloads, 0);
  assert.equal(w.videos.length, 0);
  assert.deepEqual(state().clips, {});
});

test('token do bot errado: avisa e não processa', { skip: SKIP }, async (t) => {
  const { w, env } = await setup(t, { clips: [clip('x', 'A')], env: { TELEGRAM_BOT_TOKEN: '1:errado' } });
  const r = await runClipper(env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /TELEGRAM_BOT_TOKEN/);
  assert.ok(!r.out.includes('1:errado'), 'não imprime o token');
  assert.equal(w.downloads, 0);
});

test('sem Telegram configurado: gera os arquivos mesmo assim', { skip: SKIP }, async (t) => {
  const { w, env, state } = await setup(t, { clips: [clip('x', 'A')], env: { TELEGRAM_BOT_TOKEN: '' } });
  const r = await runClipper(env);
  assert.equal(r.code, 0, r.out);
  assert.equal(w.videos.length, 0);
  assert.ok(state().clips.x.ok);
  assert.equal(fs.readdirSync(env.OUTPUT_DIR).length, 1);
});

test('faltando segredos da Twitch: sai sem erro (pra não lotar seu e-mail de falhas) e avisa', { skip: SKIP }, async (t) => {
  const { env } = await setup(t, { clips: [], env: { TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '' } });
  const r = await runClipper(env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET/);

  const onlySecret = await runClipper({ ...env, TWITCH_CLIENT_ID: 'abc' });
  assert.equal(onlySecret.code, 0, onlySecret.out);
  assert.match(onlySecret.out, /Falta TWITCH_CLIENT_SECRET /);
});

test('clipe com download quebrado: tenta mais uma vez na próxima rodada e depois desiste', { skip: SKIP }, async (t) => {
  const { w, env, state } = await setup(t, { clips: [clip('quebrado', 'A', { file: 'sumiu.mp4' }), clip('bom', 'B')] });
  await runClipper(env);
  assert.equal(w.videos.length, 1);
  assert.equal(state().clips.quebrado.fails, 1);
  await runClipper(env);
  assert.equal(state().clips.quebrado.fails, 2);
  const r3 = await runClipper(env);
  assert.equal(state().clips.quebrado.fails, 2, 'não tenta uma terceira vez');
  assert.match(r3.out, /0 escolhidos/);
  assert.equal(w.videos.length, 1);
});

test('Twitch fora do ar: avisa no Telegram uma vez só (não spamma a cada 10 min)', { skip: SKIP }, async (t) => {
  const { w, env } = await setup(t, { clips: [], twitchDown: true });
  const r1 = await runClipper(env);
  assert.equal(r1.code, 0, r1.out);
  const alerts = () => w.messages.filter((m) => /problema/.test(m.text));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].text, /503/);
  await runClipper(env);
  assert.equal(alerts().length, 1);
});

// ---------- campanhas ----------

function writeCampaigns(work, data) {
  const f = path.join(work, 'campaigns.json');
  fs.writeFileSync(f, JSON.stringify(data));
  return f;
}

const SINCE = new Date(NOW - 3 * 3600_000).toISOString(); // "maratona" começou há 3h

test('campanha: só o streamer dela, com legenda e link da campanha; geral não repete o streamer e respeita o limite por hora', { skip: SKIP }, async (t) => {
  const { w, env, work, state } = await setup(t, {
    users: { streamerx: 'X1' },
    channelClips: {
      X1: [
        clip('cx1', 'X1', { views: 900, min: 15, lang: 'en', title: 'he jumped off the building' }),
        clip('cx2', 'X1', { views: 600, min: 50, lang: 'en', file: 'b.mp4', title: 'StreamerX vs the cops' }),
        clip('cx3', 'X1', { views: 500, min: 90, lang: 'en', file: 'c.mp4' }),
        clip('antes', 'X1', { views: 9000, min: 5 * 60, lang: 'en' }), // antes do início da maratona
      ],
    },
    clips: [
      clip('gx', 'X1', { views: 5000, lang: 'en' }), // streamer da campanha aparecendo no geral
      clip('g1', 'G1', { views: 400, lang: 'pt' }),
      clip('g2', 'G2', { views: 300, lang: 'pt', file: 'b.mp4' }),
    ],
  });
  env.CAMPAIGNS_FILE = writeCampaigns(work, {
    general: { enabled: true, maxPerHour: 1 },
    campaigns: [
      {
        id: 'x-gta6', name: 'Maratona X', source: 'twitch', channels: ['streamerx'], since: SINCE, lang: 'en',
        maxPerHour: 2, maxPerRun: 2, minViews: 10, mention: 'StreamerX', hashtags: '#StreamerX #GTA6', disclosure: '#ad',
        overlay: 'STREAMERX', postWhere: 'TikTok (EN)', submitUrl: 'https://example.com/enviar', rulesUrl: 'https://example.com/regras',
      },
    ],
  });

  const r1 = await runClipper(env);
  assert.equal(r1.code, 0, r1.out);
  const camp = w.videos.filter((v) => /💰/.test(v.caption));
  const geral = w.videos.filter((v) => !/💰/.test(v.caption));
  assert.equal(camp.length, 2, r1.out);
  assert.equal(geral.length, 1, 'geral limitado a 1 por hora');
  for (const v of camp) {
    assert.match(v.caption, /Maratona X/);
    assert.match(v.caption, /href="https:\/\/example.com\/enviar"/);
    assert.match(v.caption, /<code>[\s\S]*StreamerX[\s\S]*#StreamerX #GTA6 #ad<\/code>/);
    assert.equal(probe(v.file).height, 1920);
  }
  assert.doesNotMatch(geral[0].caption, /login_X1/, 'streamer da campanha não sai no geral');
  const sent = Object.keys(state().clips).sort();
  assert.ok(!sent.includes('antes'), 'clipe de antes da maratona não entra');
  assert.ok(!sent.includes('gx'));
  assert.deepEqual(state().log.map((e) => e.k).sort(), ['geral', 'x-gta6', 'x-gta6']);
  // a busca da campanha começou no início da maratona, não 6h atrás
  const q = w.clipQueries.find((x) => x.broadcaster_id === 'X1');
  assert.ok(Math.abs(Date.parse(q.started_at) - Date.parse(SINCE)) < 5000);

  // Rodada 2 na mesma hora: campanha (2/h) e geral (1/h) já bateram o limite
  const r2 = await runClipper(env);
  assert.equal(r2.code, 0, r2.out);
  assert.equal(w.videos.length, 3);
  assert.match(r2.out, /\[x-gta6\] limite de 2\/hora/);
  assert.match(r2.out, /\[geral\] limite de 1\/hora/);
});

test('campanha com canal inexistente e campaigns.json com erro: avisa e segue com o geral', { skip: SKIP }, async (t) => {
  const { w, env, work } = await setup(t, { users: {}, clips: [clip('g1', 'G1')] });
  env.CAMPAIGNS_FILE = writeCampaigns(work, {
    campaigns: [
      { id: 'fantasma', name: 'Fantasma', channels: ['naoexiste'], submitUrl: 'https://x' },
      { id: 'Errado!', channels: [] },
    ],
  });
  const r = await runClipper(env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /canal "naoexiste" não existe na Twitch/);
  assert.match(r.out, /precisa ser tipo/);
  assert.equal(w.videos.length, 1);
});

function kickClip(id, { views = 300, min = 20, file = 'a.mp4', category = 'Grand Theft Auto VI', duration = 2, title = `kick ${id}` } = {}) {
  return {
    id, title, views, view_count: views, duration, created_at: ago(min), channel_id: 4124791,
    category: { name: category, slug: category.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
    channel: { username: 'Coringa' }, file,
  };
}

test('campanha da Kick: só clipes de GTA VI do canal, legenda em PT com #publi e créditos kick.com', { skip: SKIP }, async (t) => {
  const { w, env, work, state } = await setup(t, {
    clips: [],
    kick: {
      coringa: [
        kickClip('k-gta', { views: 900 }),
        kickClip('k-valorant', { views: 5000, category: 'VALORANT' }),
        kickClip('k-gta5', { views: 4000, category: 'Grand Theft Auto V (GTA)' }),
        kickClip('k-velho', { views: 9000, min: 5 * 60 }),
        kickClip('k-longo', { views: 800, duration: 120, file: 'b.mp4' }),
      ],
    },
  });
  env.CAMPAIGNS_FILE = writeCampaigns(work, {
    general: { enabled: false },
    campaigns: [
      {
        id: 'coringa', name: 'Ng.Cash + Coringa', source: 'kick', channels: ['coringa'], since: SINCE, lang: 'pt',
        gameOnly: true, maxDuration: 90, maxPerHour: 5, minViews: 10, mention: 'Coringa', hashtags: '#ngcash #GTA6',
        disclosure: '#publi', overlay: 'kick.com/coringa', postWhere: 'TikTok (PT)', submitUrl: 'https://viewx.example/c',
      },
    ],
  });
  const r = await runClipper(env);
  assert.equal(r.code, 0, r.out);
  assert.equal(w.videos.length, 1, r.out);
  const v = w.videos[0];
  assert.match(v.caption, /Ng\.Cash \+ Coringa/);
  // multipart troca \n por \r\n (o Telegram mostra igual)
  assert.match(v.caption.replace(/\r\n/g, '\n'), /<code>Coringa: kick k-gta\n\n🎮 Créditos: kick\.com\/coringa\n\n#ngcash #GTA6 #publi<\/code>/);
  assert.match(v.caption, /href="https:\/\/kick\.com\/coringa\/clips\/k-gta"/);
  assert.equal(probe(v.file).height, 1920);
  assert.deepEqual(Object.keys(state().clips), ['k-gta']);
  assert.match(r.out, /\[coringa\] 5 clipes dos canais da campanha, 2 dentro das regras, 1 escolhidos/);
});

test('Kick fora do ar: avisa no Telegram e as outras filas continuam', { skip: SKIP }, async (t) => {
  const { w, env, work } = await setup(t, { clips: [clip('g1', 'G1')], kick: {} });
  env.CAMPAIGNS_FILE = writeCampaigns(work, {
    general: { enabled: true, maxPerHour: 5 },
    campaigns: [{ id: 'k-sumiu', name: 'Kick sumiu', source: 'kick', channels: ['naoexiste'], submitUrl: 'https://x' }],
  });
  const r = await runClipper(env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /canal "naoexiste" não existe na Kick/);
  assert.equal(w.videos.length, 1, 'o modo geral continuou');
  assert.ok(w.messages.some((m) => /Kick sumiu/.test(m.text)), 'aviso no Telegram');
});
