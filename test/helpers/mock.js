// Servidores HTTP falsos (Twitch, Telegram, arquivos) pra testar sem internet.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

async function startServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://local');
    const entry = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(entry);
    try {
      await handler(entry, res);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(e && e.stack));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

function parseForm(entry) {
  return new Response(entry.body, { headers: { 'content-type': entry.headers['content-type'] } }).formData();
}

function parseJson(entry) {
  return JSON.parse(entry.body.toString('utf8') || '{}');
}

// ---------- mídia ----------

function hasBin(bin) {
  try {
    execFileSync(bin, [bin === 'yt-dlp' ? '--version' : '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeVideo(file, { w = 1280, h = 720, seconds = 3, fps = 30, audio = true, noise = false } = {}) {
  const vf = noise ? ['-vf', 'noise=alls=90:allf=t+u'] : [];
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push(...vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', noise ? '12' : '23', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  execFileSync('ffmpeg', args);
  return file;
}

function probe(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate:format=duration,size,bit_rate',
    '-of', 'json', file,
  ]);
  const data = JSON.parse(out);
  const v = data.streams.find((s) => s.codec_type === 'video');
  const a = data.streams.find((s) => s.codec_type === 'audio');
  const [num, den] = (v.avg_frame_rate || '0/1').split('/').map(Number);
  return {
    width: v.width,
    height: v.height,
    vcodec: v.codec_name,
    pix: v.pix_fmt,
    fps: den ? num / den : 0,
    audio: a ? a.codec_name : null,
    duration: Number(data.format.duration),
    size: Number(data.format.size),
    bitrate: Number(data.format.bit_rate),
  };
}

function serveDir(dir) {
  return async (entry, res) => {
    const file = path.join(dir, path.basename(entry.path));
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': buf.length });
    res.end(entry.method === 'HEAD' ? undefined : buf);
  };
}

module.exports = { startServer, json, parseForm, parseJson, hasBin, makeVideo, probe, serveDir };
