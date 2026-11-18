const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toVertical, download } = require('../../src/video');
const { hasBin, makeVideo, probe, startServer, serveDir } = require('../helpers/mock');

const FFMPEG = hasBin('ffmpeg');
const YTDLP = hasBin('yt-dlp');
const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/arialbd.ttf'].find((f) => fs.existsSync(f));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));

const SOURCES = [
  { name: '1080p60 com áudio', w: 1920, h: 1080, fps: 60, audio: true },
  { name: '720p sem áudio', w: 1280, h: 720, fps: 30, audio: false },
  { name: 'já vertical', w: 1080, h: 1920, fps: 30, audio: true },
  { name: '4:3', w: 640, h: 480, fps: 30, audio: true },
  { name: 'proporção quebrada 1366x768', w: 1366, h: 768, fps: 30, audio: true },
];

for (const src of SOURCES) {
  test(`vira 1080x1920 H.264 30fps: ${src.name}`, { skip: !FFMPEG && 'sem ffmpeg' }, async () => {
    const input = makeVideo(path.join(dir, `${src.w}x${src.h}-${src.fps}.mp4`), { ...src, seconds: 2 });
    const output = path.join(dir, `out-${src.w}x${src.h}.mp4`);
    const r = await toVertical(input, output, { creditText: 'twitch.tv/teste', fontFile: FONT });
    const p = probe(output);
    assert.equal(p.width, 1080);
    assert.equal(p.height, 1920);
    assert.equal(p.vcodec, 'h264');
    assert.equal(p.pix, 'yuv420p');
    assert.ok(Math.abs(p.fps - 30) < 0.1, `fps ${p.fps}`);
    assert.equal(p.audio, src.audio ? 'aac' : null);
    assert.ok(Math.abs(p.duration - 2) < 0.3, `duração ${p.duration}`);
    assert.equal(r.bytes, fs.statSync(output).size);
    assert.equal(r.fontUsed, Boolean(FONT));
  });
}

test('fonte inexistente não quebra: sai sem o texto e avisa', { skip: !FFMPEG && 'sem ffmpeg' }, async () => {
  const input = makeVideo(path.join(dir, 'semfonte.mp4'), { seconds: 1 });
  const out = path.join(dir, 'semfonte-out.mp4');
  const r = await toVertical(input, out, { creditText: 'twitch.tv/x', fontFile: '/nao/existe.ttf' });
  assert.equal(r.fontUsed, false);
  assert.equal(r.fontMissing, true);
  assert.equal(probe(out).height, 1920);
});

test('crédito com caracteres chatos (aspas, dois-pontos, %) não quebra o filtro', { skip: (!FFMPEG || !FONT) && 'sem ffmpeg/fonte' }, async () => {
  const input = makeVideo(path.join(dir, 'chato.mp4'), { seconds: 1 });
  const out = path.join(dir, 'chato-out.mp4');
  const r = await toVertical(input, out, { creditText: "twitch.tv/o'brien: 100% \\ {x}", fontFile: FONT });
  assert.equal(r.fontUsed, true);
  assert.equal(probe(out).width, 1080);
});

test('o pior caso (ruído puro) respeita o teto de bitrate, então 60s cabem nos 50 MB do Telegram', { skip: !FFMPEG && 'sem ffmpeg' }, async () => {
  const input = makeVideo(path.join(dir, 'ruido.mp4'), { w: 1280, h: 720, seconds: 10, noise: true });
  const out = path.join(dir, 'ruido-out.mp4');
  await toVertical(input, out, {});
  const p = probe(out);
  const mbps = p.bitrate / 1e6;
  const projected60s = (p.bitrate * 60) / 8 / 1048576;
  assert.ok(mbps < 5.8, `bitrate ${mbps.toFixed(2)} Mbps`);
  assert.ok(projected60s < 49, `60s daria ${projected60s.toFixed(1)} MB`);
});

test('se passar do limite, recodifica menor', { skip: !FFMPEG && 'sem ffmpeg' }, async () => {
  const input = makeVideo(path.join(dir, 'grande.mp4'), { w: 1280, h: 720, seconds: 4, noise: true });
  const normal = path.join(dir, 'grande-normal.mp4');
  const small = path.join(dir, 'grande-menor.mp4');
  const a = await toVertical(input, normal, {});
  const b = await toVertical(input, small, { limitBytes: 1 });
  assert.ok(b.bytes < a.bytes * 0.8, `${b.bytes} vs ${a.bytes}`);
  assert.equal(probe(small).height, 1920);
});

test('baixa com yt-dlp e converte (servidor local)', { skip: (!FFMPEG || !YTDLP) && 'sem ffmpeg/yt-dlp' }, async (t) => {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  makeVideo(path.join(media, 'clip.mp4'), { seconds: 2 });
  const srv = await startServer(serveDir(media));
  t.after(srv.close);
  const raw = path.join(dir, 'baixado.mp4');
  await download(`${srv.url}/clip.mp4`, raw);
  assert.equal(probe(raw).width, 1280);
  await assert.rejects(download(`${srv.url}/nao-existe.mp4`, path.join(dir, 'x.mp4')), /yt-dlp/);
});
