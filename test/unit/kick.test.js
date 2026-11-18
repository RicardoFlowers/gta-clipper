const test = require('node:test');
const assert = require('node:assert/strict');
const { createKick, normalize, listWithYtdlp } = require('../../src/kick');
const { startServer, json } = require('../helpers/mock');

// Formato real devolvido por kick.com/api/v2/channels/{canal}/clips (conferido em 18/11/2026)
const raw = (id, extra = {}) => ({
  id,
  livestream_id: '134424582',
  category_id: '1',
  channel_id: 4124791,
  user_id: 123,
  title: `clipe ${id}`,
  views: 50,
  view_count: 50,
  duration: 30,
  created_at: '2026-11-18T22:00:00.000Z',
  clip_url: `https://clips.kick.com/clips/73/${id}/playlist.m3u8`,
  video_url: `https://clips.kick.com/clips/73/${id}/playlist.m3u8`,
  category: { id: 1, name: 'Grand Theft Auto VI', slug: 'grand-theft-auto-vi' },
  channel: { id: 4124791, username: 'Coringa', slug: 'coringa' },
  ...extra,
});

test('normaliza o clipe da Kick pro formato do bot', () => {
  const c = normalize(raw('clip_1'), 'coringa');
  assert.equal(c.id, 'clip_1');
  assert.equal(c.source, 'kick');
  assert.equal(c.url, 'https://kick.com/coringa/clips/clip_1');
  assert.equal(c.downloadUrl, 'https://clips.kick.com/clips/73/clip_1/playlist.m3u8');
  assert.equal(c.broadcaster_id, 'kick:4124791');
  assert.equal(c.broadcaster_name, 'Coringa');
  assert.equal(c.login, 'coringa');
  assert.equal(c.view_count, 50);
  assert.equal(c.duration, 30);
  assert.equal(c.category, 'Grand Theft Auto VI');
  assert.equal(c.category_slug, 'grand-theft-auto-vi');
});

test('junta mais vistos (com paginação) e mais recentes, sem repetir', async (t) => {
  const reqs = [];
  const srv = await startServer(async (req, res) => {
    reqs.push(req);
    assert.match(req.headers['user-agent'], /Mozilla/);
    if (req.path !== '/api/v2/channels/coringa/clips') return json(res, 404, {});
    const sort = req.query.get('sort');
    const cursor = req.query.get('cursor');
    if (sort === 'view' && !cursor) return json(res, 200, { clips: [raw('a'), raw('b')], nextCursor: 'p2' });
    if (sort === 'view' && cursor === 'p2') return json(res, 200, { clips: [raw('c')], nextCursor: 'p3' });
    if (sort === 'date') return json(res, 200, { clips: [raw('d'), raw('a')], nextCursor: null });
    return json(res, 400, {});
  });
  t.after(srv.close);
  const kick = createKick({ base: srv.url, ytdlpList: async () => assert.fail('não devia cair no yt-dlp') });
  const clips = await kick.getChannelClips('coringa');
  assert.deepEqual(clips.map((c) => c.id), ['a', 'b', 'c', 'd']);
  assert.equal(reqs.length, 3); // 2 páginas de mais vistos + 1 de recentes
  assert.ok(reqs.every((r) => r.query.get('time') === 'day'));
});

test('canal inexistente dá erro claro', async (t) => {
  const srv = await startServer(async (req, res) => json(res, 404, { message: 'Not found' }));
  t.after(srv.close);
  const kick = createKick({ base: srv.url, ytdlpList: async () => assert.fail('não devia cair no yt-dlp') });
  await assert.rejects(kick.getChannelClips('naoexiste'), /canal "naoexiste" não existe na Kick/);
});

test('se a Cloudflare bloquear (403), cai pro yt-dlp', async (t) => {
  const srv = await startServer(async (req, res) => json(res, 403, { message: 'Just a moment...' }));
  t.after(srv.close);
  let asked;
  const kick = createKick({
    base: srv.url,
    ytdlpList: async (slug) => {
      asked = slug;
      return [normalize(raw('via-ytdlp'), slug)];
    },
  });
  const clips = await kick.getChannelClips('coringa');
  assert.equal(asked, 'coringa');
  assert.deepEqual(clips.map((c) => c.id), ['via-ytdlp']);
});

test('lê a lista do yt-dlp (formato de --flat-playlist da Kick)', async () => {
  const fakeRun = async (cmd, args) => {
    assert.equal(cmd, 'yt-dlp');
    assert.ok(args.includes('https://kick.com/coringa/clips'));
    return JSON.stringify({
      entries: [
        { id: 'clip_X', title: 'facada', categories: ['Grand Theft Auto VI'], duration: 23, view_count: 347, timestamp: 1794781300, channel: 'Coringa', channel_id: '4124791' },
      ],
    });
  };
  const [c] = await listWithYtdlp('coringa', fakeRun);
  assert.equal(c.id, 'clip_X');
  assert.equal(c.view_count, 347);
  assert.equal(c.category, 'Grand Theft Auto VI');
  assert.equal(c.created_at, new Date(1794781300 * 1000).toISOString());
  assert.equal(c.downloadUrl, 'https://kick.com/coringa/clips/clip_X');
  assert.equal(c.broadcaster_id, 'kick:4124791');
});
