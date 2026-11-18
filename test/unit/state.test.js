const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadState, saveState, markOk, markFail, emptyState } = require('../../src/state');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'state-'));
const NOW = Date.parse('2026-11-18T12:00:00Z');
const mk = (id, hoursAgo) => ({ id, broadcaster_id: 'b', created_at: new Date(NOW - hoursAgo * 3600_000).toISOString() });

test('arquivo inexistente, corrompido ou com formato errado vira estado vazio', () => {
  const dir = tmp();
  assert.deepEqual(loadState(path.join(dir, 'nao-existe.json')), emptyState());
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
  assert.deepEqual(loadState(path.join(dir, 'bad.json')), emptyState());
  fs.writeFileSync(path.join(dir, 'arr.json'), '[1,2]');
  assert.deepEqual(loadState(path.join(dir, 'arr.json')), emptyState());
  fs.writeFileSync(path.join(dir, 'clips.json'), '{"clips":[1]}');
  assert.deepEqual(loadState(path.join(dir, 'clips.json')).clips, {});
});

test('salva e carrega de volta, sem deixar arquivo temporário', () => {
  const file = path.join(tmp(), 'state.json');
  const s = emptyState();
  s.telegramChatId = 42;
  markOk(s, mk('a', 1));
  saveState(file, s, { now: NOW });
  const back = loadState(file);
  assert.equal(back.telegramChatId, 42);
  assert.equal(back.clips.a.ok, true);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('esquece clipes antigos pra o arquivo não crescer pra sempre', () => {
  const file = path.join(tmp(), 'state.json');
  const s = emptyState();
  markOk(s, mk('novo', 2));
  markOk(s, mk('velho', 80));
  s.clips.lixo = { t: 'x' };
  saveState(file, s, { now: NOW, lookbackHours: 6 });
  assert.deepEqual(Object.keys(loadState(file).clips), ['novo']);

  const s2 = emptyState();
  markOk(s2, mk('velho', 80));
  saveState(file, s2, { now: NOW, lookbackHours: 100 }); // janela grande guarda mais tempo
  assert.deepEqual(Object.keys(loadState(file).clips), ['velho']);
});

test('falhas são contadas e um sucesso depois apaga a falha', () => {
  const s = emptyState();
  const c = mk('c', 1);
  markFail(s, c, 'erro 1');
  markFail(s, c, 'erro 2');
  assert.equal(s.clips.c.fails, 2);
  assert.equal(s.clips.c.ok, false);
  assert.equal(s.clips.c.err, 'erro 2');
  markOk(s, c);
  assert.equal(s.clips.c.ok, true);
  assert.equal(s.clips.c.fails, undefined);
});

test('limite por hora: conta só a fila certa e só a última hora', () => {
  const { logSent, sentLastHour } = require('../../src/state');
  const s = emptyState();
  logSent(s, 'clix', NOW - 70 * 60_000);
  logSent(s, 'clix', NOW - 20 * 60_000);
  logSent(s, 'clix', NOW - 5 * 60_000);
  logSent(s, 'geral', NOW - 5 * 60_000);
  assert.equal(sentLastHour(s, 'clix', NOW), 2);
  assert.equal(sentLastHour(s, 'geral', NOW), 1);
  assert.equal(sentLastHour(s, 'lacy', NOW), 0);
});

test('log de envios é salvo, carregado e podado depois de 24h', () => {
  const { logSent } = require('../../src/state');
  const file = path.join(tmp(), 'state.json');
  const s = emptyState();
  logSent(s, 'velho', NOW - 25 * 3600_000);
  logSent(s, 'novo', NOW - 3600_000);
  saveState(file, s, { now: NOW });
  assert.deepEqual(loadState(file).log.map((e) => e.k), ['novo']);
  fs.writeFileSync(file, JSON.stringify({ clips: {}, log: 'lixo' }));
  assert.deepEqual(loadState(file).log, []);
});
