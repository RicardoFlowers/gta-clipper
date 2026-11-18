// Clipes da Kick. A Kick não tem endpoint oficial de clipes, então usa o mesmo que o
// site usa (kick.com/api/v2/channels/{canal}/clips). Se ele recusar (proteção da
// Cloudflare), cai pro yt-dlp, que sabe listar clipes da Kick.
const { run } = require('./video');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function normalize(raw, slug) {
  const channel = raw.channel || {};
  const category = raw.category || {};
  const id = String(raw.id || '');
  return {
    id,
    source: 'kick',
    url: `https://kick.com/${slug}/clips/${id}`, // página do clipe (pra você abrir)
    downloadUrl: raw.clip_url || raw.video_url || `https://kick.com/${slug}/clips/${id}`,
    broadcaster_id: `kick:${raw.channel_id || channel.id || slug}`,
    broadcaster_name: channel.username || slug,
    login: slug,
    title: raw.title || '',
    view_count: Number(raw.views ?? raw.view_count ?? 0),
    duration: Number(raw.duration || 0),
    created_at: raw.created_at,
    category: category.name || '',
    category_slug: category.slug || '',
  };
}

// Fallback: yt-dlp -J --flat-playlist https://kick.com/{canal}/clips
async function listWithYtdlp(slug, runImpl = run) {
  const out = await runImpl('yt-dlp', ['-J', '--flat-playlist', '--playlist-end', '50', `https://kick.com/${slug}/clips`], { timeoutMs: 120_000 });
  const data = JSON.parse(out);
  return (data.entries || []).map((e) =>
    normalize(
      {
        id: e.id,
        title: e.title,
        views: e.view_count,
        duration: e.duration,
        created_at: e.timestamp ? new Date(e.timestamp * 1000).toISOString() : undefined,
        channel_id: e.channel_id,
        channel: { username: e.channel || e.uploader },
        category: { name: (e.categories || [])[0] || '' },
      },
      slug
    )
  );
}

function createKick({ base = 'https://kick.com', fetchImpl = globalThis.fetch, ytdlpList = listWithYtdlp } = {}) {
  const root = base.replace(/\/$/, '');

  async function getJson(url) {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const err = new Error(`Kick respondeu ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Mais vistos do dia + mais recentes do dia (pra pegar clipe novo que está subindo)
  async function getChannelClips(slug, { maxPages = 2 } = {}) {
    const all = [];
    const seen = new Set();
    const add = (list) => {
      for (const c of list) {
        if (c.id && !seen.has(c.id)) {
          seen.add(c.id);
          all.push(c);
        }
      }
    };
    try {
      for (const sort of ['view', 'date']) {
        let cursor;
        for (let page = 0; page < (sort === 'view' ? maxPages : 1); page++) {
          const q = new URLSearchParams({ sort, time: 'day' });
          if (cursor) q.set('cursor', cursor);
          const data = await getJson(`${root}/api/v2/channels/${encodeURIComponent(slug)}/clips?${q}`);
          add((data.clips || []).map((c) => normalize(c, slug)));
          cursor = data.nextCursor;
          if (!cursor) break;
        }
      }
      return all;
    } catch (e) {
      if (e.status === 404) throw new Error(`canal "${slug}" não existe na Kick`);
      // 403/429/503 costuma ser a Cloudflare: tenta pelo yt-dlp
      add(await ytdlpList(slug));
      return all;
    }
  }

  return { getChannelClips };
}

module.exports = { createKick, normalize, listWithYtdlp };
