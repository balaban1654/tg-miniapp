import { randomBytes } from 'node:crypto';

export const REVIEW_PHOTO_MAX = 5 * 1024 * 1024;

/** Картинка из data-URL или base64. Возвращает файл, null (нет фото) или текст ошибки */
export function parseReviewPhoto(raw: unknown): { data: Buffer; type: string; key: string } | null | string {
  if (typeof raw !== 'string' || !raw) return null;
  const data = Buffer.from(raw.replace(/^data:[^,]*,/, ''), 'base64');
  let type = '';
  if (data.length > 12) {
    if (data[0] === 0xff && data[1] === 0xd8) type = 'image/jpeg';
    else if (data.subarray(1, 4).toString() === 'PNG') type = 'image/png';
    else if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') type = 'image/webp';
  }
  if (!type) return 'Фото должно быть картинкой JPG, PNG или WebP';
  if (data.length > REVIEW_PHOTO_MAX) return 'Фото больше 5 МБ';
  return { data, type, key: randomBytes(12).toString('hex') };
}

export function cleanReviewText(v: unknown): string {
  return String(v ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
}

export const cleanRating = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};
