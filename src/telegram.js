// Envio pelo bot do Telegram (Bot API). Limite de vídeo enviado por bot: 50 MB.

const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createTelegram({ token, apiBase, fetchImpl = globalThis.fetch }) {
  const base = `${apiBase.replace(/\/$/, '')}/bot${token}`;

  async function call(method, payload = {}, attempt = 0) {
    const isForm = payload instanceof FormData;
    let res;
    try {
      res = await fetchImpl(`${base}/${method}`, {
        method: 'POST',
        body: isForm ? payload : JSON.stringify(payload),
        headers: isForm ? undefined : { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      // Nunca incluir a URL no erro: ela contém o token do bot
      throw new Error(`Telegram ${method}: falha de rede (${(e.cause && e.cause.code) || e.name})`);
    }
    const data = await res.json().catch(() => null);
    if (data && data.ok) return data.result;

    const retryAfter = data && data.parameters && data.parameters.retry_after;
    if (res.status === 429 && retryAfter && attempt < 2) {
      await sleep(Math.min(retryAfter, 60) * 1000);
      return call(method, payload, attempt + 1);
    }
    const err = new Error(`Telegram ${method}: ${(data && data.description) || `HTTP ${res.status}`}`);
    err.status = res.status;
    throw err;
  }

  const getMe = () => call('getMe');

  // Descobre o chat de quem mandou /start pro bot (a conversa privada mais recente)
  async function detectChatId() {
    const updates = await call('getUpdates', { limit: 100, timeout: 0 });
    for (let i = updates.length - 1; i >= 0; i--) {
      const u = updates[i];
      const chat = (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat);
      if (chat && chat.type === 'private') return chat.id;
    }
    return null;
  }

  const sendMessage = (chatId, html) =>
    call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });

  async function sendVideo(chatId, file, { caption, width, height, duration } = {}) {
    const blob =
      typeof fs.openAsBlob === 'function'
        ? await fs.openAsBlob(file, { type: 'video/mp4' })
        : new Blob([fs.readFileSync(file)], { type: 'video/mp4' });
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    form.append('supports_streaming', 'true');
    if (width) form.append('width', String(width));
    if (height) form.append('height', String(height));
    if (duration) form.append('duration', String(Math.round(duration)));
    form.append('video', blob, path.basename(file));
    return call('sendVideo', form);
  }

  return { getMe, detectChatId, sendMessage, sendVideo };
}

module.exports = { createTelegram };
