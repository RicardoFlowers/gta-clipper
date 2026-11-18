const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTelegram } = require('../../src/telegram');
const { startServer, json, parseForm, parseJson } = require('../helpers/mock');

const TOKEN = '123456:SECRET-TOKEN';

async function setup({ updates = [], fail429 = 0 } = {}) {
  const st = { fail429, sent: [] };
  const srv = await startServer(async (req, res) => {
    const m = req.path.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m || m[1] !== TOKEN) return json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const method = m[2];
    if (st.fail429 > 0) {
      st.fail429--;
      return json(res, 429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
    }
    if (method === 'getMe') return json(res, 200, { ok: true, result: { id: 1, is_bot: true, username: 'gta_clipper_bot' } });
    if (method === 'getUpdates') return json(res, 200, { ok: true, result: updates });
    if (method === 'sendMessage') {
      st.sent.push({ method, body: parseJson(req) });
      return json(res, 200, { ok: true, result: { message_id: 1 } });
    }
    if (method === 'sendVideo') {
      const form = await parseForm(req);
      st.sent.push({ method, form });
      return json(res, 200, { ok: true, result: { message_id: 2 } });
    }
    return json(res, 400, { ok: false, description: 'Bad Request: method not found' });
  });
  return { srv, st, tg: createTelegram({ token: TOKEN, apiBase: srv.url }) };
}

test('getMe valida o token', async (t) => {
  const { srv, tg } = await setup();
  t.after(srv.close);
  assert.equal((await tg.getMe()).username, 'gta_clipper_bot');
  const bad = createTelegram({ token: 'errado', apiBase: srv.url });
  await assert.rejects(bad.getMe(), /Unauthorized/);
});

test('descobre o chat de quem mandou /start (o mais recente, só conversa privada)', async (t) => {
  const updates = [
    { update_id: 1, message: { chat: { id: 111, type: 'private' }, text: '/start' } },
    { update_id: 2, message: { chat: { id: -500, type: 'group' }, text: 'oi' } },
    { update_id: 3, message: { chat: { id: 222, type: 'private' }, text: '/start' } },
    { update_id: 4, edited_message: { chat: { id: 999, type: 'private' } } },
  ];
  const { srv, tg } = await setup({ updates });
  t.after(srv.close);
  assert.equal(await tg.detectChatId(), 222);
});

test('sem ninguém ter mandado /start, não inventa chat', async (t) => {
  const { srv, tg } = await setup({ updates: [] });
  t.after(srv.close);
  assert.equal(await tg.detectChatId(), null);
});

test('mensagem de texto vai em HTML e sem prévia de link', async (t) => {
  const { srv, tg, st } = await setup();
  t.after(srv.close);
  await tg.sendMessage(42, '<b>oi</b>');
  assert.deepEqual(st.sent[0].body, { chat_id: 42, text: '<b>oi</b>', parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
});

test('vídeo vai como multipart com o arquivo inteiro e os metadados', async (t) => {
  const { srv, tg, st } = await setup();
  t.after(srv.close);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-')), 'video.mp4');
  const bytes = Buffer.alloc(300_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  fs.writeFileSync(file, bytes);

  await tg.sendVideo(42, file, { caption: '<code>legenda</code>', width: 1080, height: 1920, duration: 29.6 });
  const form = st.sent[0].form;
  assert.equal(form.get('chat_id'), '42');
  assert.equal(form.get('caption'), '<code>legenda</code>');
  assert.equal(form.get('parse_mode'), 'HTML');
  assert.equal(form.get('supports_streaming'), 'true');
  assert.equal(form.get('width'), '1080');
  assert.equal(form.get('height'), '1920');
  assert.equal(form.get('duration'), '30');
  const video = form.get('video');
  assert.equal(video.name, 'video.mp4');
  assert.ok(Buffer.from(await video.arrayBuffer()).equals(bytes));
});

test('respeita o "tente de novo em X segundos" do Telegram', async (t) => {
  const { srv, tg } = await setup({ fail429: 1 });
  t.after(srv.close);
  const start = Date.now();
  assert.equal((await tg.getMe()).username, 'gta_clipper_bot');
  assert.ok(Date.now() - start >= 900);
});

test('erro de rede não vaza o token do bot na mensagem', async () => {
  const tg = createTelegram({ token: TOKEN, apiBase: 'http://127.0.0.1:9' }); // porta sem ninguém ouvindo
  await assert.rejects(tg.getMe(), (e) => {
    assert.match(e.message, /falha de rede/);
    assert.ok(!e.message.includes('SECRET-TOKEN'));
    return true;
  });
});
