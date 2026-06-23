// Transcode recorded audio to OGG/Opus (WhatsApp's voice-friendly format) using
// the bundled static ffmpeg binary.
//
// Why: browser MediaRecorder output (Chrome fragmented MP4, Firefox/others webm)
// is ACCEPTED at WhatsApp upload but then fails asynchronously during delivery
// ("Media upload error"). Normalizing to OGG/Opus mono makes voice notes
// actually deliver.
//
// Vercel notes (verified on the deployed runtime):
//  - the binary lives under /var/task and the FS is READ-ONLY, so we must NOT
//    chmod it (it's already executable) and must read/write only under /tmp.
//  - libopus is present in the johnvansickle static build.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static'); // path string to the binary
} catch (_) {
  ffmpegPath = null;
}

function isAvailable() {
  return Boolean(ffmpegPath && fs.existsSync(ffmpegPath));
}

// Transcode an input audio Buffer -> OGG/Opus Buffer.
// Returns { ok, buffer, mime, ext } or { ok:false, error }.
async function toOggOpus(inputBuffer, srcExtHint) {
  if (!isAvailable()) {
    return { ok: false, error: 'Audio transcoder is unavailable on the server.' };
  }
  const stamp = `${process.pid}-${Date.now()}-${Math.floor(performance.now())}`;
  const ext = (srcExtHint || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
  const inPath = path.join(os.tmpdir(), `wa-in-${stamp}.${ext}`);
  const outPath = path.join(os.tmpdir(), `wa-out-${stamp}.ogg`);

  try {
    await fs.promises.writeFile(inPath, inputBuffer);
    // -ac 1: mono (voice). -b:a 32k: plenty for speech, small + fast.
    // -application voip: tunes libopus for speech. -vn: drop any video track.
    await run(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-y',
       '-i', inPath,
       '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
       outPath],
      { timeout: 30000, maxBuffer: 1024 * 1024 }
    );
    const buffer = await fs.promises.readFile(outPath);
    if (!buffer.length) return { ok: false, error: 'Transcode produced an empty file.' };
    return { ok: true, buffer, mime: 'audio/ogg', ext: 'ogg' };
  } catch (e) {
    return { ok: false, error: `Audio transcode failed: ${e.message}` };
  } finally {
    // best-effort cleanup of the /tmp scratch files
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

module.exports = { toOggOpus, isAvailable, ffmpegPath };
