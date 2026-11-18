const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { readConfig, ROOT } = require('../../src/config');

test('padrões quando nada está configurado', () => {
  const c = readConfig({});
  assert.equal(c.gameName, 'Grand Theft Auto VI');
  assert.deepEqual(c.languages, ['pt', 'en']);
  assert.equal(c.boostLang, 'pt');
  assert.equal(c.boost, 3);
  assert.equal(c.minViews, 50);
  assert.equal(c.clipsPerRun, 3);
  assert.equal(c.maxPerStreamer, 1);
  assert.equal(c.lookbackHours, 6);
  assert.equal(c.maxDuration, 60);
  assert.match(c.hashtags, /#GTA6/);
  assert.equal(c.stateFile, path.join(ROOT, 'state.json'));
  assert.equal(c.twitchApiBase, 'https://api.twitch.tv/helix');
});

test('variáveis vazias (como vêm do GitHub quando não existem) usam o padrão', () => {
  const c = readConfig({ LANGUAGES: '', MIN_VIEWS: '', GAME_NAME: '  ', HASHTAGS: '', BOOST_LANG: '', CLIPS_PER_RUN: ' ' });
  assert.deepEqual(c.languages, ['pt', 'en']);
  assert.equal(c.minViews, 50);
  assert.equal(c.gameName, 'Grand Theft Auto VI');
  assert.equal(c.boostLang, 'pt');
  assert.equal(c.clipsPerRun, 3);
});

test('idiomas: all, pt-BR e espaços', () => {
  assert.deepEqual(readConfig({ LANGUAGES: 'all' }).languages, []);
  assert.deepEqual(readConfig({ LANGUAGES: 'ALL' }).languages, []);
  assert.deepEqual(readConfig({ LANGUAGES: ' PT-BR , en ,' }).languages, ['pt', 'en']);
  assert.deepEqual(readConfig({ LANGUAGES: 'es' }).languages, ['es']);
});

test('boost de idioma pode ser trocado ou desligado', () => {
  assert.equal(readConfig({ BOOST_LANG: 'none' }).boostLang, '');
  assert.equal(readConfig({ BOOST_LANG: 'EN' }).boostLang, 'en');
  assert.equal(readConfig({ BOOST_LANG: 'pt_BR' }).boostLang, 'pt');
});

test('números inválidos caem no padrão, zero é respeitado', () => {
  const c = readConfig({ MIN_VIEWS: 'abc', CLIPS_PER_RUN: '5', MAX_PER_STREAMER: '0', LOOKBACK_HOURS: '12.5' });
  assert.equal(c.minViews, 50);
  assert.equal(c.clipsPerRun, 5);
  assert.equal(c.maxPerStreamer, 0);
  assert.equal(c.lookbackHours, 12.5);
});

test('segredos têm espaços removidos (colar com espaço no GitHub é comum)', () => {
  const c = readConfig({ TWITCH_CLIENT_ID: '  abc \n', TWITCH_CLIENT_SECRET: '\tdef ', TELEGRAM_BOT_TOKEN: ' 1:x ' });
  assert.equal(c.clientId, 'abc');
  assert.equal(c.clientSecret, 'def');
  assert.equal(c.telegramToken, '1:x');
});

test('caminhos absolutos são mantidos', () => {
  const c = readConfig({ STATE_FILE: '/tmp/x/state.json', OUTPUT_DIR: '/tmp/out' });
  assert.equal(c.stateFile, '/tmp/x/state.json');
  assert.equal(c.outDir, '/tmp/out');
});
