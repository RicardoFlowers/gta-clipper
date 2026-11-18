// Cliente mínimo da API oficial da Twitch (Helix) com token de app.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createTwitch({ clientId, clientSecret, apiBase, authUrl, fetchImpl = globalThis.fetch }) {
  let token = null;
  let tokenExp = 0;
  const base = apiBase.replace(/\/$/, '');

  async function getToken() {
    if (token && Date.now() < tokenExp - 60_000) return token;
    const res = await fetchImpl(authUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = [400, 401, 403].includes(res.status) ? ' (confira TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET)' : '';
      throw new Error(`Twitch recusou o login (${res.status})${hint}: ${text.slice(0, 200)}`);
    }
    const data = JSON.parse(text);
    token = data.access_token;
    tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
    return token;
  }

  async function helix(endpoint, params = {}, attempt = 0) {
    const url = new URL(`${base}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetchImpl(url, {
      headers: { 'Client-Id': clientId, Authorization: `Bearer ${await getToken()}` },
      signal: AbortSignal.timeout(20_000),
    });

    if (res.status === 401 && attempt === 0) {
      token = null; // token expirou ou foi revogado: pega outro e tenta de novo
      return helix(endpoint, params, attempt + 1);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const reset = Number(res.headers.get('ratelimit-reset'));
      const wait = res.status === 429 && reset ? Math.min(Math.max(reset * 1000 - Date.now(), 500), 30_000) : 1000 * (attempt + 1);
      await sleep(wait);
      return helix(endpoint, params, attempt + 1);
    }
    if (!res.ok) throw new Error(`Twitch ${endpoint} respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async function findGame(name) {
    const exact = await helix('games', { name });
    if (exact.data && exact.data.length) return exact.data[0];

    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const search = await helix('search/categories', { query: name, first: 10 });
    const list = search.data || [];
    const hit = list.find((g) => norm(g.name) === norm(name)) || list[0];
    if (hit) return hit;
    throw new Error(`Categoria "${name}" não encontrada na Twitch`);
  }

  async function fetchWindow(gameId, hours, maxPages, seen, all) {
    const now = Date.now();
    const query = {
      game_id: gameId,
      started_at: new Date(now - hours * 3600_000).toISOString(),
      ended_at: new Date(now).toISOString(),
      first: 100,
    };
    let after;
    for (let page = 0; page < maxPages; page++) {
      const res = await helix('clips', after ? { ...query, after } : query);
      for (const c of res.data || []) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          all.push(c);
        }
      }
      after = res.pagination && res.pagination.cursor;
      if (!after) break;
    }
  }

  // Clipes da categoria. A Twitch devolve ordenado por views, então no pico (milhares de
  // clipes) só os 300 mais vistos das últimas 6h apareceriam e os clipes novos que estão
  // subindo ficariam de fora. Por isso busca também a última hora separadamente.
  async function getClips(gameId, lookbackHours, { maxPages = 3, recentHours = 1, recentPages = 2 } = {}) {
    const all = [];
    const seen = new Set();
    await fetchWindow(gameId, lookbackHours, maxPages, seen, all);
    if (recentHours > 0 && recentHours < lookbackHours) await fetchWindow(gameId, recentHours, recentPages, seen, all);
    return all;
  }

  // Revoga o token no fim da rodada: cada execução no GitHub pede um token novo,
  // e não faz sentido deixar centenas de tokens válidos acumulando
  async function revoke() {
    if (!token) return;
    const t = token;
    token = null;
    tokenExp = 0;
    await fetchImpl(authUrl.replace(/\/token$/, '/revoke'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token: t }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  // id do streamer -> login (o nome que vai na URL twitch.tv/login)
  async function getLogins(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    const map = new Map();
    for (let i = 0; i < unique.length; i += 100) {
      const res = await helix('users', { id: unique.slice(i, i + 100) });
      for (const u of res.data || []) map.set(u.id, u.login);
    }
    return map;
  }

  return { findGame, getClips, getLogins, revoke };
}

module.exports = { createTwitch };
