const test = require('node:test');
const assert = require('node:assert/strict');
const { createTwitch } = require('../../src/twitch');
const { startServer, json } = require('../helpers/mock');

function fakeTwitch(over = {}) {
  const st = { tokens: 0, fail401: 0, fail429: 0, fail500: 0, ...over };
  const handler = async (req, res) => {
    if (req.path === '/oauth2/token') {
      const body = new URLSearchParams(req.body.toString());
      if (body.get('client_id') !== 'cid' || body.get('client_secret') !== 'sec' || body.get('grant_type') !== 'client_credentials')
        return json(res, 403, { message: 'invalid client secret' });
      st.tokens++;
      return json(res, 200, { access_token: `tok${st.tokens}`, expires_in: 5000000, token_type: 'bearer' });
    }
    assert.equal(req.headers['client-id'], 'cid');
    const auth = req.headers.authorization;
    if (st.fail401 > 0) {
      st.fail401--;
      return json(res, 401, { message: 'Invalid OAuth token' });
    }
    if (st.fail429 > 0) {
      st.fail429--;
      return json(res, 429, { message: 'Too Many Requests' }, { 'ratelimit-reset': String(Math.ceil(Date.now() / 1000)) });
    }
    if (st.fail500 > 0) {
      st.fail500--;
      return json(res, 503, { message: 'unavailable' });
    }
    assert.match(auth, /^Bearer tok\d+$/);
    const p = req.path.replace('/helix/', '');
    if (p === 'games') return json(res, 200, { data: req.query.get('name') === 'Grand Theft Auto VI' ? [{ id: '123', name: 'Grand Theft Auto VI' }] : [] });
    if (p === 'search/categories')
      return json(res, 200, {
        data: req.query.get('query') === 'nada' ? [] : [{ id: '9', name: 'Grand Theft Auto V' }, { id: '123', name: 'Grand Theft Auto VI' }],
      });
    if (p === 'clips') {
      const after = req.query.get('after');
      const page = after ? Number(after) : 0;
      const ids = [[1, 2, 3], [3, 4, 5], [6, 7], [8]][page] || [];
      const next = page < 3 ? String(page + 1) : undefined;
      return json(res, 200, {
        data: ids.map((i) => ({ id: `c${i}`, view_count: 100 - i })),
        pagination: next ? { cursor: next } : {},
      });
    }
    if (p === 'users') {
      const ids = req.query.getAll('id');
      return json(res, 200, { data: ids.map((id) => ({ id, login: `login_${id}` })) });
    }
    return json(res, 404, {});
  };
  return { st, handler };
}

async function setup(over) {
  const { st, handler } = fakeTwitch(over);
  const srv = await startServer(handler);
  const tw = createTwitch({ clientId: 'cid', clientSecret: 'sec', apiBase: `${srv.url}/helix`, authUrl: `${srv.url}/oauth2/token` });
  return { srv, tw, st };
}

test('autentica uma vez e reaproveita o token', async (t) => {
  const { srv, tw, st } = await setup();
  t.after(srv.close);
  await tw.findGame('Grand Theft Auto VI');
  await tw.findGame('Grand Theft Auto VI');
  assert.equal(st.tokens, 1);
  const tokenReq = srv.requests.find((r) => r.path === '/oauth2/token');
  assert.equal(tokenReq.method, 'POST');
});

test('acha a categoria pelo nome exato ou pela busca', async (t) => {
  const { srv, tw } = await setup();
  t.after(srv.close);
  assert.equal((await tw.findGame('Grand Theft Auto VI')).id, '123');
  assert.equal((await tw.findGame('grand theft auto vi')).id, '123'); // via busca, casando nome normalizado
  await assert.rejects(tw.findGame('nada'), /não encontrada/);
});

test('busca clipes com janela de tempo, pagina e remove repetidos', async (t) => {
  const { srv, tw } = await setup();
  t.after(srv.close);
  const clips = await tw.getClips('123', 6);
  assert.deepEqual(clips.map((c) => c.id), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']); // 3 páginas no máximo
  const req = srv.requests.find((r) => r.path === '/helix/clips');
  assert.equal(req.query.get('game_id'), '123');
  assert.equal(req.query.get('first'), '100');
  const span = Date.parse(req.query.get('ended_at')) - Date.parse(req.query.get('started_at'));
  assert.ok(Math.abs(span - 6 * 3600_000) < 5000);
});

test('token expirado: pega outro e repete a chamada', async (t) => {
  const { srv, tw, st } = await setup({ fail401: 1 });
  t.after(srv.close);
  assert.equal((await tw.findGame('Grand Theft Auto VI')).id, '123');
  assert.equal(st.tokens, 2);
});

test('limite de requisições (429) e instabilidade (5xx): espera e tenta de novo', async (t) => {
  const { srv, tw } = await setup({ fail429: 1, fail500: 1 });
  t.after(srv.close);
  assert.equal((await tw.findGame('Grand Theft Auto VI')).id, '123');
});

test('credenciais erradas dão erro claro', async (t) => {
  const { handler } = fakeTwitch();
  const srv = await startServer(handler);
  t.after(srv.close);
  const tw = createTwitch({ clientId: 'cid', clientSecret: 'errado', apiBase: `${srv.url}/helix`, authUrl: `${srv.url}/oauth2/token` });
  await assert.rejects(tw.findGame('Grand Theft Auto VI'), /TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET/);
});

test('busca também a última hora, pra clipe novo não sumir atrás dos 300 mais vistos', async (t) => {
  const srv = await startServer(async (req, res) => {
    if (req.path === '/oauth2/token') return json(res, 200, { access_token: 'tok', expires_in: 999999 });
    if (req.path === '/helix/clips') {
      const hours = (Date.parse(req.query.get('ended_at')) - Date.parse(req.query.get('started_at'))) / 3600_000;
      const page = Number(req.query.get('after') || 0);
      if (hours > 2) return json(res, 200, { data: [{ id: `velho${page}` }], pagination: { cursor: String(page + 1) } });
      return json(res, 200, { data: [{ id: `novo${page}` }, { id: 'velho0' }], pagination: { cursor: String(page + 1) } });
    }
    return json(res, 404, {});
  });
  t.after(srv.close);
  const tw = createTwitch({ clientId: 'cid', clientSecret: 'sec', apiBase: `${srv.url}/helix`, authUrl: `${srv.url}/oauth2/token` });
  const ids = (await tw.getClips('1', 6)).map((c) => c.id);
  assert.deepEqual(ids, ['velho0', 'velho1', 'velho2', 'novo0', 'novo1']); // 3 páginas de 6h + 2 da última hora, sem repetir
  const only6h = (await tw.getClips('1', 6, { recentHours: 0 })).map((c) => c.id);
  assert.deepEqual(only6h, ['velho0', 'velho1', 'velho2']);
});

test('revoga o token no fim e não revoga se nem pegou token', async (t) => {
  const revoked = [];
  const srv = await startServer(async (req, res) => {
    if (req.path === '/oauth2/token') return json(res, 200, { access_token: 'tok-x', expires_in: 999999 });
    if (req.path === '/oauth2/revoke') {
      revoked.push(new URLSearchParams(req.body.toString()));
      return json(res, 200, {});
    }
    return json(res, 200, { data: [{ id: '1', name: 'Grand Theft Auto VI' }] });
  });
  t.after(srv.close);
  const tw = createTwitch({ clientId: 'cid', clientSecret: 'sec', apiBase: `${srv.url}/helix`, authUrl: `${srv.url}/oauth2/token` });
  await tw.revoke();
  assert.equal(revoked.length, 0);
  await tw.findGame('Grand Theft Auto VI');
  await tw.revoke();
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].get('token'), 'tok-x');
  assert.equal(revoked[0].get('client_id'), 'cid');
});

test('logins dos streamers em lotes de 100', async (t) => {
  const { srv, tw } = await setup();
  t.after(srv.close);
  const ids = Array.from({ length: 150 }, (_, i) => String(i));
  const map = await tw.getLogins([...ids, '1', '', null]);
  assert.equal(map.size, 150);
  assert.equal(map.get('7'), 'login_7');
  const userReqs = srv.requests.filter((r) => r.path === '/helix/users');
  assert.deepEqual(userReqs.map((r) => r.query.getAll('id').length), [100, 50]);
});
