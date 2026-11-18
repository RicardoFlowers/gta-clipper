const test = require('node:test');
const assert = require('node:assert/strict');
const { selectClips, score, MAX_FAILS } = require('../../src/select');
const { emptyState, markOk, markFail } = require('../../src/state');
const { readConfig } = require('../../src/config');

const NOW = Date.parse('2026-11-18T12:00:00Z');
let seq = 0;
function clip({ id, b = 'b1', views = 100, dur = 30, lang = 'pt', ageMin = 10 } = {}) {
  seq++;
  return {
    id: id || `clip${seq}`,
    url: `https://clips.twitch.tv/${id || seq}`,
    broadcaster_id: b,
    broadcaster_name: `Streamer_${b}`,
    language: lang,
    title: `título ${seq}`,
    view_count: views,
    duration: dur,
    created_at: new Date(NOW - ageMin * 60_000).toISOString(),
  };
}
const cfg = (over = {}) => ({ ...readConfig({}), ...over });

test('filtra idioma, views mínimas e duração', () => {
  const clips = [
    clip({ id: 'ok', b: 'a', views: 100 }),
    clip({ id: 'es', b: 'b', lang: 'es', views: 9999 }),
    clip({ id: 'poucas', b: 'c', views: 10 }),
    clip({ id: 'longo', b: 'd', dur: 90 }),
    clip({ id: '60.3s', b: 'e', dur: 60.3 }),
    clip({ id: 'ptbr', b: 'f', lang: 'pt-br' }),
  ];
  const ids = selectClips(clips, emptyState(), cfg({ clipsPerRun: 10 }), NOW).map((c) => c.id).sort();
  assert.deepEqual(ids, ['60.3s', 'ok', 'ptbr']);
});

test('LANGUAGES=all aceita qualquer idioma', () => {
  const clips = [clip({ id: 'es', b: 'a', lang: 'es' }), clip({ id: 'ja', b: 'b', lang: 'ja' })];
  assert.equal(selectClips(clips, emptyState(), cfg({ languages: [], clipsPerRun: 10 }), NOW).length, 2);
});

test('não repete clipe já enviado; tenta de novo o que falhou até o limite', () => {
  const sent = clip({ id: 'sent', b: 'a' });
  const failedOnce = clip({ id: 'f1', b: 'b', ageMin: 300 });
  const failedMax = clip({ id: 'fmax', b: 'c', ageMin: 300 });
  const state = emptyState();
  markOk(state, sent);
  markFail(state, failedOnce, 'x');
  for (let i = 0; i < MAX_FAILS; i++) markFail(state, failedMax, 'x');
  const ids = selectClips([sent, failedOnce, failedMax], state, cfg({ clipsPerRun: 10 }), NOW).map((c) => c.id);
  assert.deepEqual(ids, ['f1']);
});

test('mesmo momento clipado por várias pessoas vira um clipe só (o melhor)', () => {
  const a1 = clip({ id: 'a1', b: 'a', views: 500, ageMin: 10 });
  const a2 = { ...clip({ id: 'a2', b: 'a', views: 300 }), created_at: new Date(Date.parse(a1.created_at) + 45_000).toISOString() };
  const otherMoment = { ...clip({ id: 'a3', b: 'a', views: 200 }), created_at: new Date(Date.parse(a1.created_at) + 10 * 60_000).toISOString() };
  const ids = selectClips([a2, a1, otherMoment], emptyState(), cfg({ clipsPerRun: 10, maxPerStreamer: 0 }), NOW).map((c) => c.id);
  assert.deepEqual(ids.sort(), ['a1', 'a3']);
});

test('não manda de novo um momento que já foi enviado em outra rodada', () => {
  const first = clip({ id: 'x1', b: 'a', views: 500 });
  const state = emptyState();
  markOk(state, first);
  const sameMoment = { ...clip({ id: 'x2', b: 'a', views: 900 }), created_at: new Date(Date.parse(first.created_at) - 60_000).toISOString() };
  const otherStreamer = { ...sameMoment, id: 'x3', broadcaster_id: 'z' };
  const ids = selectClips([sameMoment, otherStreamer], state, cfg({ clipsPerRun: 10 }), NOW).map((c) => c.id);
  assert.deepEqual(ids, ['x3']);
});

test('limite por streamer e por rodada', () => {
  const clips = [
    clip({ b: 'a', views: 900, ageMin: 5 }),
    clip({ b: 'a', views: 800, ageMin: 30 }),
    clip({ b: 'b', views: 700, ageMin: 50 }),
    clip({ b: 'c', views: 600, ageMin: 70 }),
    clip({ b: 'd', views: 500, ageMin: 90 }),
  ];
  const picked = selectClips(clips, emptyState(), cfg({ clipsPerRun: 3, maxPerStreamer: 1 }), NOW);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((c) => c.broadcaster_id)).size, 3);

  const unlimited = selectClips(clips, emptyState(), cfg({ clipsPerRun: 10, maxPerStreamer: 0 }), NOW);
  assert.equal(unlimited.length, 5);
});

test('clipe novo bombando passa na frente de clipe velho com um pouco mais de view', () => {
  const c = cfg({ boostLang: '' });
  const fresh = clip({ b: 'a', views: 1000, ageMin: 15, lang: 'en' });
  const old = clip({ b: 'b', views: 1500, ageMin: 5 * 60, lang: 'en' });
  assert.ok(score(fresh, c, NOW) > score(old, c, NOW));
  assert.equal(selectClips([old, fresh], emptyState(), cfg({ clipsPerRun: 1, boostLang: '' }), NOW)[0].id, fresh.id);
});

test('idioma prioritário (pt) ganha boost na ordem', () => {
  const en = clip({ b: 'a', views: 1000, lang: 'en', ageMin: 30 });
  const pt = clip({ b: 'b', views: 500, lang: 'pt', ageMin: 30 });
  assert.equal(selectClips([en, pt], emptyState(), cfg({ clipsPerRun: 1 }), NOW)[0].id, pt.id);
  assert.equal(selectClips([en, pt], emptyState(), cfg({ clipsPerRun: 1, boostLang: '' }), NOW)[0].id, en.id);
});

test('ids repetidos na lista não geram envio duplo', () => {
  const c = clip({ id: 'dup', b: 'a' });
  assert.equal(selectClips([c, { ...c }], emptyState(), cfg({ clipsPerRun: 10, maxPerStreamer: 0 }), NOW).length, 1);
});

test('lista vazia ou datas estranhas não quebram', () => {
  assert.deepEqual(selectClips([], emptyState(), cfg(), NOW), []);
  const weird = { ...clip({ b: 'a' }), created_at: 'not-a-date' };
  assert.equal(selectClips([weird], emptyState(), cfg(), NOW).length, 1);
});
