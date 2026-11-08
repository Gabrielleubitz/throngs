import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { isHeadlessTranscript } from '../src/fileWatcher.js';

const write = (lines: object[]) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-headless-')), 's.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
};

describe('isHeadlessTranscript: scripted `claude -p` runs are not adopted as office characters', () => {
  it('a headless run (entrypoint sdk-cli) is headless', () => {
    expect(isHeadlessTranscript(write([{ type: 'queue-operation' }, { type: 'user', entrypoint: 'sdk-cli', userType: 'external' }]))).toBe(true);
  });
  it('an interactive session (entrypoint cli) is shown as before', () => {
    expect(isHeadlessTranscript(write([{ type: 'user', entrypoint: 'cli', userType: 'external' }]))).toBe(false);
  });
  it('an empty or missing transcript is treated as interactive (old behaviour)', () => {
    expect(isHeadlessTranscript(write([]))).toBe(false);
    expect(isHeadlessTranscript('/nonexistent/x.jsonl')).toBe(false);
  });
});
