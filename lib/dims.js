// Pixel size of a photo, sticker or video, read from the file's own header.
// The inbox reserves each one's space from it before the bytes arrive, so a
// chat does not keep growing after it opens.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function png(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function gif(b) {
  if (b.length < 10 || b.toString('latin1', 0, 3) !== 'GIF') return null;
  return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
}

function webp(b) {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

// Orientation 5 to 8 means the camera was held sideways: browsers turn the
// picture, so its shown width is the stored height.
function exifOrientation(b, start, end) {
  if (b.toString('latin1', start, start + 6) !== 'Exif\0\0') return 1;
  const tiff = start + 6;
  if (tiff + 8 > end) return 1;
  const le = b.toString('latin1', tiff, tiff + 2) === 'II';
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return 1;
}

function jpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  let turn = 1;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const marker = b[o + 1];
    if (marker === 0xff) { o++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { o += 2; continue; }
    const len = b.readUInt16BE(o + 2);
    if (len < 2) return null;
    if (marker === 0xe1) turn = exifOrientation(b, o + 4, Math.min(b.length, o + 2 + len));
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      const h = b.readUInt16BE(o + 5);
      const w = b.readUInt16BE(o + 7);
      return turn >= 5 && turn <= 8 ? { w: h, h: w } : { w, h };
    }
    if (marker === 0xda) return null;
    o += 2 + len;
  }
  return null;
}

function imageSize(buffer) {
  try {
    const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    const d = png(b) || jpeg(b) || gif(b) || webp(b);
    return d && d.w > 0 && d.h > 0 && d.w < 65536 && d.h < 65536 ? d : null;
  } catch (_) {
    return null;
  }
}

// ffmpeg prints the stream's size on stderr and exits non-zero without an
// output file, which is all that is needed here.
function parseVideoInfo(text) {
  const line = String(text || '').split('\n').find((l) => /Stream #.*Video:/.test(l));
  const m = line && / (\d{2,5})x(\d{2,5})[ ,\[]/.exec(line);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const rot = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(text) || /rotate\s*:\s*(-?\d+)/.exec(text);
  const sideways = rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90;
  return sideways ? { w: h, h: w } : { w, h };
}

async function videoSize(buffer, ext) {
  let ffmpegPath = null;
  try { ffmpegPath = require('ffmpeg-static'); } catch (_) { return null; }
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) return null;
  const file = path.join(os.tmpdir(), `wa-size-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${String(ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4'}`);
  try {
    await fs.promises.writeFile(file, buffer);
    const text = await new Promise((resolve) => {
      execFile(ffmpegPath, ['-hide_banner', '-i', file], { timeout: 8000, maxBuffer: 512 * 1024 }, (_err, _out, stderr) => resolve(stderr));
    });
    return parseVideoInfo(text);
  } catch (_) {
    return null;
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

async function mediaSize(buffer, mime, ext) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (m.startsWith('image/')) return imageSize(buffer);
  if (m.startsWith('video/')) return videoSize(buffer, ext);
  return null;
}

// media_meta with the size added, or the same object when there is none.
function withSize(mediaMeta, size) {
  return size ? { ...(mediaMeta || {}), w: size.w, h: size.h } : mediaMeta;
}

module.exports = { imageSize, videoSize, parseVideoInfo, mediaSize, withSize };
