const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TELEGRAM_LIMIT = 49 * 1024 * 1024; // bots do Telegram enviam até 50 MB

function run(cmd, args, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`"${cmd}" não está instalado ou não está no PATH`) : e);
    });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${signal ? `foi encerrado (${signal})` : `saiu com código ${code}`}: ${err.trim().slice(-800)}`));
    });
  });
}

async function checkTools() {
  await run('ffmpeg', ['-hide_banner', '-version'], { timeoutMs: 30_000 });
  await run('yt-dlp', ['--version'], { timeoutMs: 30_000 });
}

async function download(url, outFile) {
  fs.rmSync(outFile, { force: true });
  await run(
    'yt-dlp',
    ['--quiet', '--no-warnings', '--no-progress', '--no-playlist', '--retries', '3', '--socket-timeout', '30',
      '-f', 'best[ext=mp4]/best', '-o', outFile, url],
    { timeoutMs: 180_000 }
  );
  if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) throw new Error('yt-dlp não gerou o arquivo');
}

// Valor dentro do -filter_complex passa por 2 níveis de escape do ffmpeg:
// 1) opção do filtro (\ ' :)  2) filtergraph (\ ' [ ] , ;). Ex.: "C:/x" e "it's [a], b; c"
function ffEscape(value) {
  const optionLevel = String(value).replace(/[\\':]/g, '\\$&');
  return optionLevel.replace(/[\\'[\],;]/g, '\\$&');
}

function ffPath(p) {
  return ffEscape(path.resolve(p).replace(/\\/g, '/'));
}

function buildFilter({ textFile, fontFile, topTextFile, topSeconds = 3 }) {
  // Fundo: o próprio vídeo ampliado e desfocado (desfoca em baixa resolução, bem mais rápido)
  let f =
    '[0:v]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920,setsar=1[bg];' +
    // Frente: vídeo inteiro cabendo na largura, centralizado
    '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fg];' +
    '[bg][fg]overlay=(W-w)/2:(H-h)/2';
  if (textFile && fontFile) {
    f +=
      `,drawtext=fontfile=${ffPath(fontFile)}:textfile=${ffPath(textFile)}` +
      ':fontsize=48:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=1390';
  }
  // Aviso de publicidade (#ad) no começo do vídeo, que as campanhas pedem
  if (topTextFile && fontFile) {
    f +=
      `,drawtext=fontfile=${ffPath(fontFile)}:textfile=${ffPath(topTextFile)}` +
      ':fontsize=56:fontcolor=white:borderw=4:bordercolor=black:box=1:boxcolor=black@0.35:boxborderw=14' +
      `:x=(w-text_w)/2:y=230:enable=${ffEscape(`between(t,0,${Number(topSeconds) || 3})`)}`;
  }
  return `${f},format=yuv420p[v]`;
}

async function encode(inFile, outFile, filter, maxrate, maxSeconds = 62) {
  const bufsize = `${parseInt(maxrate, 10) * 2}${maxrate.replace(/^[0-9]+/, '')}`;
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inFile,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '0:a?',
    '-t', String(maxSeconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', maxrate, '-bufsize', bufsize,
    '-profile:v', 'high', '-r', '30', '-g', '60',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    outFile,
  ]);
}

/**
 * Converte pra 1080x1920 (9:16): vídeo original no meio, fundo desfocado
 * e, se tiver fonte, o crédito do streamer escrito embaixo.
 */
async function toVertical(inFile, outFile, { creditText, topText, fontFile, limitBytes = TELEGRAM_LIMIT, maxSeconds = 62 } = {}) {
  const hasFont = Boolean(fontFile && fs.existsSync(fontFile));
  const fontOk = Boolean(hasFont && creditText);
  let textFile = null;
  let topTextFile = null;
  if (fontOk) {
    textFile = `${outFile}.credit.txt`;
    fs.writeFileSync(textFile, creditText);
  }
  if (hasFont && topText) {
    topTextFile = `${outFile}.top.txt`;
    fs.writeFileSync(topTextFile, topText);
  }
  try {
    const filter = buildFilter({ textFile, topTextFile, fontFile: hasFont ? fontFile : null });
    await encode(inFile, outFile, filter, '5M', maxSeconds);
    let bytes = fs.statSync(outFile).size;
    if (bytes > limitBytes) {
      await encode(inFile, outFile, filter, '2500k', maxSeconds);
      bytes = fs.statSync(outFile).size;
    }
    return { bytes, fontUsed: fontOk, fontMissing: Boolean(fontFile && !hasFont && (creditText || topText)) };
  } finally {
    if (textFile) fs.rmSync(textFile, { force: true });
    if (topTextFile) fs.rmSync(topTextFile, { force: true });
  }
}

module.exports = { run, checkTools, download, toVertical, buildFilter, ffEscape, TELEGRAM_LIMIT };
