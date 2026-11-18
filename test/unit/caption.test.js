const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanTitle, escapeHtml, postCaption, telegramCaption, formatViews, campaignPostCaption, campaignTelegramCaption } = require('../../src/caption');

// Texto visível depois que o Telegram interpreta o HTML (é isso que conta no limite de 1024)
const visible = (html) =>
  html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

const base = {
  id: 'Abc',
  url: 'https://clips.twitch.tv/Abc?x=1&y=2',
  broadcaster_name: 'Gaules',
  language: 'pt',
  title: 'GTA 6 DIA 1 !pix !insta',
  view_count: 12345,
  duration: 29.6,
};

test('limpa comandos de chat do título', () => {
  assert.equal(cleanTitle('GTA 6 DIA 1 !pix !insta'), 'GTA 6 DIA 1');
  assert.equal(cleanTitle('!sorteio | MELHOR BUG'), 'MELHOR BUG');
  assert.equal(cleanTitle('caiu do prédio KKKKK !!!'), 'caiu do prédio KKKKK !!!');
  assert.equal(cleanTitle('GTA 6!'), 'GTA 6!');
  assert.equal(cleanTitle('🔴 ELE CAIU DO PRÉDIO 🔴 !pix'), 'ELE CAIU DO PRÉDIO');
  assert.equal(cleanTitle('!pix !loja'), 'GTA 6 🔥');
  assert.equal(cleanTitle(''), 'GTA 6 🔥');
  assert.equal(cleanTitle(null), 'GTA 6 🔥');
  assert.ok(cleanTitle('a'.repeat(400)).length <= 150);
});

test('escapa HTML', () => {
  assert.equal(escapeHtml('<b>"a" & b</b>'), '&lt;b&gt;&quot;a&quot; &amp; b&lt;/b&gt;');
});

test('legenda pra postar tem título, crédito com login e hashtags', () => {
  const t = postCaption(base, 'gaules', '#GTA6 #GTAVI');
  assert.equal(t, 'GTA 6 DIA 1\n\n🎮 Créditos: twitch.tv/gaules\n\n#GTA6 #GTAVI');
});

test('legenda do Telegram: HTML seguro, bloco copiável e link', () => {
  const evil = { ...base, title: 'ele </code><b>quebrou</b> & saiu', broadcaster_name: 'A<B>' };
  const html = telegramCaption(evil, 'ab', '#GTA6');
  assert.match(html, /<code>[\s\S]*<\/code>$/);
  assert.equal((html.match(/<code>/g) || []).length, 1);
  assert.equal((html.match(/<\/code>/g) || []).length, 1);
  assert.ok(html.includes('&lt;/code&gt;&lt;b&gt;quebrou'));
  assert.ok(html.includes('<b>A&lt;B&gt;</b>'));
  assert.ok(html.includes('href="https://clips.twitch.tv/Abc?x=1&amp;y=2"'));
  assert.ok(html.includes('12 mil views'));
  assert.ok(html.includes('30s'));
});

test('legenda do Telegram nunca passa de 1024 caracteres visíveis', () => {
  const html = telegramCaption({ ...base, title: 'x'.repeat(100) }, 'login', '#tag '.repeat(400));
  assert.ok(visible(html).length <= 1024, `tamanho ${visible(html).length}`);
});

test('formata views', () => {
  assert.equal(formatViews(999), '999');
  assert.equal(formatViews(1500), '1,5 mil');
  assert.equal(formatViews(25_400), '25 mil');
  assert.equal(formatViews(1_200_000), '1,2 mi');
  assert.equal(formatViews(999_700), '1,0 mi');
  assert.equal(formatViews(999_400), '999 mil');
  assert.equal(formatViews(9_960), '10 mil');
  assert.equal(formatViews(9_940), '9,9 mil');
  assert.equal(formatViews(undefined), '0');
});

// ---------- campanhas ----------

const camp = {
  name: 'Maratona <Clix> & cia',
  source: 'twitch',
  lang: 'en',
  mention: 'Clix',
  hashtags: '#Clix #GTA6',
  disclosure: '#ad',
  postWhere: 'TikTok (inglês)',
  submitUrl: 'https://contentrewards.com/c/campaigns/abc?x=1&y=2',
  rulesUrl: 'https://reachclipping.com/ClixGTA',
};

test('legenda de campanha: menciona o streamer, hashtags e #ad', () => {
  const t = campaignPostCaption({ ...base, title: 'he crashed the car !discord' }, 'clix', camp);
  assert.equal(t, 'Clix: he crashed the car\n\n📺 twitch.tv/clix\n\n#Clix #GTA6 #ad');
});

test('não repete o nome se o título já menciona (sem diferenciar maiúscula)', () => {
  const t = campaignPostCaption({ ...base, title: 'CLIX loses it in GTA 6' }, 'clix', camp);
  assert.ok(t.startsWith('CLIX loses it in GTA 6\n'));
});

test('campanha em português e da Kick usa crédito em PT e kick.com', () => {
  const t = campaignPostCaption({ ...base, title: 'fugiu da polícia' }, 'coringa', {
    ...camp, lang: 'pt', source: 'kick', mention: 'Coringa', hashtags: '#ngcash', disclosure: '#publi',
  });
  assert.equal(t, 'Coringa: fugiu da polícia\n\n🎮 Créditos: kick.com/coringa\n\n#ngcash #publi');
});

test('mensagem do Telegram da campanha: nome, onde postar, links e legenda copiável, tudo escapado', () => {
  const html = campaignTelegramCaption(base, 'clix', camp);
  assert.ok(html.includes('💰 <b>Maratona &lt;Clix&gt; &amp; cia</b>'));
  assert.ok(html.includes('Postar em: TikTok (inglês)'));
  assert.ok(html.includes('href="https://contentrewards.com/c/campaigns/abc?x=1&amp;y=2"'));
  assert.ok(html.includes('href="https://reachclipping.com/ClixGTA"'));
  assert.match(html, /30 min/);
  assert.match(html, /<code>[\s\S]*#Clix #GTA6 #ad<\/code>$/);
  assert.ok(visible(html).length <= 1024);
});

test('mensagem da campanha continua dentro do limite com hashtags enormes', () => {
  const html = campaignTelegramCaption({ ...base, title: 'x'.repeat(150) }, 'clix', { ...camp, hashtags: '#tag '.repeat(300) });
  assert.ok(visible(html).length <= 1024, `tamanho ${visible(html).length}`);
});
