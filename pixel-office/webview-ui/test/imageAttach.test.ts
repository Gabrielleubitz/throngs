import { describe, expect, it } from 'vitest';

import { imageFiles, withImages } from '../src/sm/imageAttach.js';

const file = (type: string) => ({ type }) as File;

describe('withImages', () => {
  it('leaves text alone with no images', () => {
    expect(withImages('  hi ', [])).toBe('hi');
  });
  it('appends the saved paths', () => {
    expect(withImages('look', ['/a/x.png'])).toContain('an image for context');
    expect(withImages('look', ['/a/x.png', '/a/y.png'])).toMatch(/images[\s\S]*- \/a\/x\.png\n- \/a\/y\.png$/);
  });
});

describe('imageFiles', () => {
  it('reads screenshots that only appear as clipboard items', () => {
    const dt = { files: [], items: [{ kind: 'file', getAsFile: () => file('image/png') }, { kind: 'string', getAsFile: () => null }] } as unknown as DataTransfer;
    expect(imageFiles(dt)).toHaveLength(1);
  });
  it('ignores non-image files', () => {
    const dt = { files: [file('text/plain'), file('image/gif')], items: [] } as unknown as DataTransfer;
    expect(imageFiles(dt)).toHaveLength(1);
  });
});
