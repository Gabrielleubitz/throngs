/** Image attachments for office requests: pure helpers shared by every agent message input. */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** The image files on a paste/drop clipboard (screenshots arrive as items with no entry in `files`). */
export function imageFiles(dt: DataTransfer): File[] {
  const files = Array.from(dt.files);
  const fromItems = files.length ? files : Array.from(dt.items).flatMap((it) => (it.kind === 'file' ? [it.getAsFile()] : []));
  return fromItems.filter((f): f is File => !!f && f.type.startsWith('image/'));
}

/** The saved paths ride along in the prompt, so ARES, the Planner and every worker can Read them. */
export function withImages(text: string, paths: string[]): string {
  if (!paths.length) return text.trim();
  const many = paths.length > 1;
  return `${text.trim()}\n\nThe owner attached ${many ? 'images' : 'an image'} for context. View ${many ? 'each' : 'it'} with the Read tool before planning or working:\n${paths.map((p) => `- ${p}`).join('\n')}`;
}
