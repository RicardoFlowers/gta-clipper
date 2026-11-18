const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCampaigns, isActive, DEFAULT_FILE } = require('../../src/campaigns');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-'));
const write = (name, data) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
  return f;
};

test('o campaigns.json do repositório é válido', () => {
  const r = loadCampaigns(DEFAULT_FILE);
  assert.deepEqual(r.problems, []);
  assert.ok(r.campaigns.length >= 1);
  for (const c of r.campaigns) {
    assert.ok(c.submitUrl.startsWith('https://'), `${c.id} sem link de envio`);
    assert.ok(c.hashtags, `${c.id} sem hashtags`);
  }
});

test('sem arquivo: modo geral ligado e sem limite por hora (comportamento antigo)', () => {
  const r = loadCampaigns(path.join(dir, 'nao-existe.json'));
  assert.deepEqual(r, { general: { enabled: true, maxPerHour: 0 }, campaigns: [], problems: [] });
});

test('JSON quebrado vira aviso, não crash', () => {
  const r = loadCampaigns(write('quebrado.json', '{ "campaigns": ['));
  assert.equal(r.campaigns.length, 0);
  assert.match(r.problems[0], /campaigns.json inválido/);
});

test('normaliza campos e aplica padrões', () => {
  const r = loadCampaigns(
    write('ok.json', {
      general: { enabled: false, maxPerHour: 5 },
      campaigns: [{ id: 'abc-1', channels: 'Clix, LACY ', lang: 'EN', since: '2026-11-18T00:00:00Z', submitUrl: 'https://x' }],
    })
  );
  assert.deepEqual(r.general, { enabled: false, maxPerHour: 5 });
  const c = r.campaigns[0];
  assert.deepEqual(c.channels, ['clix', 'lacy']);
  assert.equal(c.lang, 'en');
  assert.equal(c.source, 'twitch');
  assert.equal(c.maxPerHour, 3);
  assert.equal(c.maxPerRun, 2);
  assert.equal(c.since, Date.parse('2026-11-18T00:00:00Z'));
  assert.equal(c.until, null);
  assert.equal(c.enabled, true);
});

test('campanha com erro é descartada com explicação; as boas continuam', () => {
  const r = loadCampaigns(
    write('mix.json', {
      campaigns: [
        { id: 'Com Espaço', channels: ['a'] },
        { id: 'sem-canal', channels: [] },
        { id: 'fonte-ruim', source: 'youtube', channels: ['a'] },
        { id: 'data-ruim', channels: ['a'], since: 'ontem' },
        { id: 'boa', channels: ['a'] },
        { id: 'boa', channels: ['b'] },
      ],
    })
  );
  assert.deepEqual(r.campaigns.map((c) => c.id), ['boa']);
  const all = r.problems.join(' | ');
  assert.match(all, /precisa ser tipo/);
  assert.match(all, /sem-canal: "channels" vazio/);
  assert.match(all, /source "youtube" não suportado/);
  assert.match(all, /data-ruim: "since" não é uma data válida/);
  assert.match(all, /id repetido: boa/);
});

test('isActive respeita enabled e until', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  assert.equal(isActive({ enabled: true, until: null }, now), true);
  assert.equal(isActive({ enabled: false, until: null }, now), false);
  assert.equal(isActive({ enabled: true, until: Date.parse('2026-11-19T00:00:00Z') }, now), false);
  assert.equal(isActive({ enabled: true, until: Date.parse('2026-12-01T00:00:00Z') }, now), true);
});
