/** Thumbnails of attached images, each with a remove button. */
import type { AttachedImage } from './useImageAttach.js';

export function ImageStrip({ images, onRemove, className = '' }: { images: AttachedImage[]; onRemove: (path: string) => void; className?: string }) {
  if (!images.length) return null;
  return (
    <div className={`flex gap-4 flex-wrap ${className}`}>
      {images.map((img) => (
        <div key={img.path} className="relative">
          <img src={img.url} alt="attachment" className="block w-[48px] h-[48px] object-cover border-2 border-border" />
          <button className="absolute -top-2 -right-2 bg-bg-dark border-2 border-border text-text text-2xs cursor-pointer leading-none px-2"
            title="Remove" onClick={() => onRemove(img.path)}>×</button>
        </div>
      ))}
    </div>
  );
}
