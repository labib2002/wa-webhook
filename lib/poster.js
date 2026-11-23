// A still frame for each stored video, kept beside it as <path>.poster.jpg, so
// a chat and the media strip show the picture instead of an icon. Made when
// the video is stored, or on first request for a video stored before.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const transcode = require('./transcode');

const run = promisify(execFile);
const POSTER_WIDTH = 480;

function posterPath(videoPath) {
  return `${videoPath}.poster.jpg`;
}

function readDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr || ''));
  if (!m) return null;
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 10) / 10 : null;
}

// -> { ok, jpg, duration } or { ok: false, error }
async function makePoster(videoBuffer, extHint) {
  if (!transcode.isAvailable()) return { ok: false, error: 'Video tools are unavailable on the server.' };
  const stamp = `${process.pid}-${Date.now()}-${Math.floor(performance.now())}`;
  const ext = (extHint || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
  const inPath = path.join(os.tmpdir(), `wa-pin-${stamp}.${ext}`);
  const outPath = path.join(os.tmpdir(), `wa-pout-${stamp}.jpg`);
  try {
    await fs.promises.writeFile(inPath, videoBuffer);
    let duration = null;
    try {
      await run(transcode.ffmpegPath, ['-hide_banner', '-i', inPath], { timeout: 20000, maxBuffer: 1024 * 1024 });
    } catch (e) {
      duration = readDuration(e.stderr);
    }
    const frameAt = async (at) => {
      await run(
        transcode.ffmpegPath,
        ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', inPath, '-frames:v', '1',
          '-vf', `scale='min(${POSTER_WIDTH},iw)':-2`, '-q:v', '6', outPath],
        { timeout: 30000, maxBuffer: 1024 * 1024 }
      );
      const jpg = await fs.promises.readFile(outPath).catch(() => Buffer.alloc(0));
      return jpg;
    };
    let jpg = await frameAt(duration && duration < 1 ? 0 : 0.5).catch(() => Buffer.alloc(0));
    if (!jpg.length) jpg = await frameAt(0).catch(() => Buffer.alloc(0));
    if (!jpg.length) return { ok: false, error: 'No frame could be read from the video.' };
    return { ok: true, jpg, duration };
  } catch (e) {
    return { ok: false, error: `Poster failed: ${e.message}` };
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

// Stores the poster for a video already in the bucket. -> duration or null.
async function storePoster(bucket, videoPath, videoBuffer, extHint) {
  const made = await makePoster(videoBuffer, extHint);
  if (!made.ok) {
    console.warn(`poster for ${videoPath}: ${made.error}`);
    return null;
  }
  const { error } = await bucket.upload(posterPath(videoPath), made.jpg, { contentType: 'image/jpeg', upsert: true });
  if (error) {
    console.warn(`poster upload for ${videoPath}: ${error.message}`);
    return null;
  }
  return { duration: made.duration };
}

module.exports = { posterPath, makePoster, storePoster, readDuration, POSTER_WIDTH };
