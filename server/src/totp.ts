import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf: Buffer): string {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHA[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHA[(val << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Buffer {
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = ALPHA.indexOf(ch);
    if (i < 0) continue;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = (): string => base32(randomBytes(20));

function hotp(key: Buffer, counter: number): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(c).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Проверка кода с допуском ±1 шаг (30 с). Возвращает номер шага или null. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const key = unbase32(secret);
  const step = Math.floor(now / 30_000);
  for (const d of [0, -1, 1]) {
    const exp = Buffer.from(hotp(key, step + d));
    if (timingSafeEqual(exp, Buffer.from(clean))) return step + d;
  }
  return null;
}

export const otpUri = (secret: string, account: string, issuer = 'Hunter Office'): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** Резервные коды вида abcde-12345 */
export function newRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const h = randomBytes(5).toString('hex');
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
}
