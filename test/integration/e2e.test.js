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
function world({ clips, updates = [{ update_id: 1, message: { chat: { id: 777, type: 'private' }, text: '/start' } }], twitchDown = false }) {
  const w = { clips, updates, twitchDown, videos: [], messages: [], downloads: 0 };
  const files = serveDir(media);
  w.handler = async (req, res) => {
    if (req.path.startsWith('/media/')) {
      w.downloads++;
      return files(req, res);
    }
    if (req.path === '/oauth2/token') return json(res, 200, { access_token: 't', expires_in: 9999 });
    if (req.path.startsWith('/helix/')) {
      if (w.twitchDown) return json(res, 503, { message: 'Service Unavailable' });
      const p = req.path.slice(7);
      if (p === 'games') return json(res, 200, { data: [{ id: '42', name: 'Grand Theft Auto VI' }] });
      if (p === 'clips') return json(res, 200, { data: w.clips.map((c) => ({ ...c, url: `${w.base}/media/${c.file}` })), pagination: {} });
      if (p === 'users') return json(res, 200, { data: req.query.getAll('id').map((id) => ({ id, login: `login_${id}` })) });
    }
    const m = req.path.match(/^\/bot([^/]+)\/(\w+)$/);
    if (m) {
      if (m[1] !== TOKEN) return json(res, 401, { ok: false, description: 'Unauthorized' });
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
  fs.rmSync(work, { recursive: true, force: true });
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
