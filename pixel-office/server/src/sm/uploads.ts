/**
 * Image attachments for office requests. Images are validated (type by magic bytes, size), saved under
 * <SM_ROOT>/office/uploads/ with a random server-made filename (the client's name is never used), and the
 * absolute path is returned so it can be put in a prompt for Claude's Read tool.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function sniff(buf: Buffer): string | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const bad = (message: string, status = 400) => Object.assign(new Error(message), { status });

/** body: { type, data } where data is base64 (optionally a data: URL). */
export function saveImage(root: string, body: unknown): { path: string; name: string; type: string; size: number } {
  const b = (body ?? {}) as { type?: unknown; data?: unknown };
  const type = String(b.type ?? '').toLowerCase();
  if (!EXT[type]) throw bad('Only png, jpg, gif or webp images can be attached');
  const b64 = String(b.data ?? '').replace(/^data:[^,]*,/, '');
  if (b64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8) throw bad('Image is too large (max 8 MB)', 413);
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw bad('Empty image');
  if (buf.length > MAX_UPLOAD_BYTES) throw bad('Image is too large (max 8 MB)', 413);
  const real = sniff(buf);
  if (real !== type) throw bad('File contents do not match an allowed image type');
  const dir = path.join(root, 'office', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const name = `img-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}.${EXT[real]}`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o600 });
  return { path: file, name, type: real, size: buf.length };
}
