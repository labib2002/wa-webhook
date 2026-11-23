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

async function transcode(inputBuffer, srcExtHint, outExt, codecArgs) {
  if (!isAvailable()) {
    return { ok: false, error: 'Audio transcoder is unavailable on the server.' };
  }
  const stamp = `${process.pid}-${Date.now()}-${Math.floor(performance.now())}`;
  const ext = (srcExtHint || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
  const inPath = path.join(os.tmpdir(), `wa-in-${stamp}.${ext}`);
  const outPath = path.join(os.tmpdir(), `wa-out-${stamp}.${outExt}`);

  try {
    await fs.promises.writeFile(inPath, inputBuffer);
    await run(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath, '-vn', '-ac', '1', ...codecArgs, outPath],
      { timeout: 30000, maxBuffer: 1024 * 1024 }
    );
    const buffer = await fs.promises.readFile(outPath);
    if (!buffer.length) return { ok: false, error: 'Transcode produced an empty file.' };
    return { ok: true, buffer };
  } catch (e) {
    return { ok: false, error: `Audio transcode failed: ${e.message}` };
  } finally {
    // best-effort cleanup of the /tmp scratch files
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

// Transcode an input audio Buffer -> OGG/Opus Buffer.
// Returns { ok, buffer, mime, ext } or { ok:false, error }.
// -b:a 32k is plenty for speech; -application voip tunes libopus for it.
//
// A browser that records in Opus (Chrome) hands over its own start offset, and
// ffmpeg writes it into the first page's sample count. WhatsApp refuses such a
// voice note ("Media file scrutiny", 131053). Writing the container again with
// the audio copied gives exact counts.
async function toOggOpus(inputBuffer, srcExtHint) {
  const out = await transcode(inputBuffer, srcExtHint, 'ogg',
    ['-c:a', 'libopus', '-b:a', '32k', '-application', 'voip']);
  if (!out.ok) return out;
  const exact = await transcode(out.buffer, 'ogg', 'ogg', ['-c:a', 'copy']);
  return { ...(exact.ok ? exact : out), mime: 'audio/ogg', ext: 'ogg' };
}

// Safari on iPhone cannot play WhatsApp's OGG/Opus voice notes (or AMR), so
// the inbox asks for an AAC copy. faststart lets playback begin before the end.
async function toM4a(inputBuffer, srcExtHint) {
  const out = await transcode(inputBuffer, srcExtHint, 'm4a',
    ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart']);
  return out.ok ? { ...out, mime: 'audio/mp4', ext: 'm4a' } : out;
}

// WhatsApp refuses some phone videos ("No video stream found") whose audio
// track comes before the picture: a Samsung screen recording, for one. The same
// file rewritten with the picture first and the index at the front delivers.
// Nothing is re-encoded.
async function videoFirst(inputBuffer, srcExtHint) {
  if (!isAvailable()) return { ok: false, error: 'Video tools are unavailable on the server.' };
  const stamp = `${process.pid}-${Date.now()}-${Math.floor(performance.now())}`;
  const ext = (srcExtHint || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
  const inPath = path.join(os.tmpdir(), `wa-vin-${stamp}.${ext}`);
  const outPath = path.join(os.tmpdir(), `wa-vout-${stamp}.mp4`);
  try {
    await fs.promises.writeFile(inPath, inputBuffer);
    await run(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', outPath],
      { timeout: 60000, maxBuffer: 1024 * 1024 }
    );
    const buffer = await fs.promises.readFile(outPath);
    if (!buffer.length) return { ok: false, error: 'The video came out empty.' };
    return { ok: true, buffer, mime: 'video/mp4', ext: 'mp4' };
  } catch (e) {
    return { ok: false, error: `Video rewrite failed: ${e.message}` };
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

module.exports = { toOggOpus, toM4a, videoFirst, isAvailable, ffmpegPath };
