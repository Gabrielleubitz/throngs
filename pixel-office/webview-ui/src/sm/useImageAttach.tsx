/** Paste / drop / pick images into an agent message input: uploads through /sm/upload, keeps thumbnails. */
import { type ClipboardEvent, type DragEvent, useCallback, useState } from 'react';

import { ALLOWED_IMAGE_TYPES, imageFiles } from './imageAttach.js';
import { smClient } from './smClient.js';

export interface AttachedImage { path: string; url: string }

export function useImageAttach() {
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const attach = useCallback(async (files: File[]) => {
    const pics = files.filter((f) => ALLOWED_IMAGE_TYPES.includes(f.type));
    if (pics.length < files.length) setError('Only png, jpg, gif or webp images can be attached.');
    for (const f of pics) {
      setUploading((n) => n + 1);
      try {
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error('Could not read the image'));
          r.readAsDataURL(f);
        });
        const saved = await smClient.upload(f.type, data);
        setImages((prev) => [...prev, { path: saved.path, url: data }]);
      } catch (e) { setError((e as Error).message); } finally { setUploading((n) => n - 1); }
    }
  }, []);

  const onPaste = (e: ClipboardEvent) => {
    const f = imageFiles(e.clipboardData);
    if (f.length) { e.preventDefault(); void attach(f); }
  };
  const onDrop = (e: DragEvent) => {
    const f = imageFiles(e.dataTransfer);
    if (f.length) { e.preventDefault(); void attach(f); }
  };
  const onDragOver = (e: DragEvent) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); };
  const remove = (path: string) => setImages((prev) => prev.filter((i) => i.path !== path));
  const clear = () => setImages([]);

  return { images, uploading, error, setError, attach, onPaste, onDrop, onDragOver, remove, clear, paths: images.map((i) => i.path) };
}
