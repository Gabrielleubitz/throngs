import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { saveImage } from '../src/sm/uploads.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sm-upload-'));

describe('saveImage', () => {
  it('saves a png under office/uploads with a random name, ignoring any client name', () => {
    const r = root();
    const out = saveImage(r, { type: 'image/png', name: '../../evil.sh', data: `data:image/png;base64,${PNG.toString('base64')}` });
    expect(path.dirname(out.path)).toBe(path.join(r, 'office', 'uploads'));
    expect(out.name).toMatch(/^img-[a-z0-9]+-[0-9a-f]{16}\.png$/);
    expect(fs.readFileSync(out.path).equals(PNG)).toBe(true);
  });
  it('rejects disallowed types and content that does not match the type', () => {
    const r = root();
    expect(() => saveImage(r, { type: 'image/svg+xml', data: PNG.toString('base64') })).toThrow(/png, jpg, gif or webp/);
    expect(() => saveImage(r, { type: 'image/jpeg', data: PNG.toString('base64') })).toThrow(/do not match/);
    expect(() => saveImage(r, { type: 'image/png', data: Buffer.from('<script>').toString('base64') })).toThrow(/do not match/);
  });
  it('rejects oversized and empty images', () => {
    const r = root();
    const big = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
    expect(() => saveImage(r, { type: 'image/png', data: big.toString('base64') })).toThrow(/too large/);
    expect(() => saveImage(r, { type: 'image/png', data: '' })).toThrow(/Empty/);
  });
});
