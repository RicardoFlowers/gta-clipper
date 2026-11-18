function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Tira comandos de chat tipo "!pix !insta" e sobras de separadores
function cleanTitle(title) {
  let t = String(title || '')
    .replace(/(^|\s)![\p{L}\p{N}_]+/gu, ' ')
    .replace(/🔴/gu, ' ') // "ao vivo" não faz sentido num clipe
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s|\-–—:•·]+|[\s|\-–—:•·]+$/g, '')
    .trim();
  if (t.length > 150) t = `${t.slice(0, 147).trimEnd()}...`;
  return t || 'GTA 6 🔥';
}

// Texto pronto pra colar no TikTok / Reels / Shorts
function postCaption(clip, login, hashtags) {
  return [cleanTitle(clip.title), '', `🎮 Créditos: twitch.tv/${login}`, '', hashtags].join('\n').trim();
}

function formatViews(n) {
  const v = Number(n) || 0;
  // limites ajustados pro arredondamento: 999.700 vira "1,0 mi" e não "1000 mil"
  if (v >= 999_500) return `${(v / 1_000_000).toFixed(1).replace('.', ',')} mi`;
  if (v >= 9_950) return `${Math.round(v / 1000)} mil`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace('.', ',')} mil`;
  return String(v);
}

// Legenda da mensagem no Telegram (HTML). O bloco <code> copia com um toque.
// Limite do Telegram: 1024 caracteres visíveis.
function telegramCaption(clip, login, hashtags) {
  const head = `🎬 <b>${escapeHtml(clip.broadcaster_name)}</b> · ${formatViews(clip.view_count)} views · ${Math.round(clip.duration || 0)}s · ${escapeHtml(clip.language || '?')}`;
  const link = `<a href="${escapeHtml(clip.url)}">clipe original</a>`;
  let body = postCaption(clip, login, hashtags);
  if (body.length > 800) body = `${body.slice(0, 797)}...`;
  return `${head}\n${link}\n\n👇 toque pra copiar a legenda\n<code>${escapeHtml(body)}</code>`;
}

// ---------- campanhas ----------

// Legenda pra postar numa campanha: o nome do streamer tem que aparecer (regra comum),
// hashtags obrigatórias e o aviso de publicidade (#ad / #publi).
function campaignPostCaption(clip, login, camp) {
  let title = cleanTitle(clip.title);
  if (camp.mention && !title.toLowerCase().includes(camp.mention.toLowerCase())) title = `${camp.mention}: ${title}`;
  const site = camp.source === 'kick' ? 'kick.com' : 'twitch.tv';
  const credit = camp.lang === 'en' ? `📺 ${site}/${login}` : `🎮 Créditos: ${site}/${login}`;
  const tags = [camp.hashtags, camp.disclosure].filter(Boolean).join(' ');
  return [title, '', credit, '', tags].join('\n').trim();
}

function campaignTelegramCaption(clip, login, camp) {
  const lines = [
    `💰 <b>${escapeHtml(camp.name)}</b>`,
    `🎬 ${escapeHtml(clip.broadcaster_name)} · ${formatViews(clip.view_count)} views · ${Math.round(clip.duration || 0)}s`,
  ];
  if (camp.postWhere) lines.push(`📲 Postar em: ${escapeHtml(camp.postWhere)}`);
  const links = [];
  if (camp.submitUrl) links.push(`<a href="${escapeHtml(camp.submitUrl)}">enviar o link</a>`);
  if (camp.rulesUrl && camp.rulesUrl !== camp.submitUrl) links.push(`<a href="${escapeHtml(camp.rulesUrl)}">regras</a>`);
  links.push(`<a href="${escapeHtml(clip.url)}">clipe original</a>`);
  lines.push(`⏱ Depois de postar, envie o link em até 30 min · ${links.join(' · ')}`);
  let body = campaignPostCaption(clip, login, camp);
  if (body.length > 600) body = `${body.slice(0, 597)}...`;
  return `${lines.join('\n')}\n\n👇 toque pra copiar a legenda\n<code>${escapeHtml(body)}</code>`;
}

module.exports = {
  escapeHtml,
  cleanTitle,
  postCaption,
  telegramCaption,
  formatViews,
  campaignPostCaption,
  campaignTelegramCaption,
};
