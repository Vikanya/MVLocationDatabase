// Screenshots → WebP like the admin's upload setting (≤ 2560 px, quality 85), named after their content
// (first 12 hex characters of the SHA-1, as the migrated screenshots are) so the same image is stored once.

const MAX = 2560;
const QUALITY = 0.85;

export interface Encoded {
  blob: Blob;
  /** 12 hex characters; the file is public/media/full/<hash>.webp */
  hash: string;
}

export async function toWebp(file: Blob): Promise<Encoded> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', QUALITY));
  if (!blob || blob.type !== 'image/webp') throw new Error('This browser can’t make WebP images — use Chrome, Edge or Firefox.');
  const digest = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer());
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  return { blob, hash };
}

/** Image files from a paste or drop event. */
export function imagesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...data.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) return files;
  return [...data.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()!).filter(Boolean);
}
