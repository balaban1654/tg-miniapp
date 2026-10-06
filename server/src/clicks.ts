/** Разбор клика по ссылке: устройство, система, браузер, откуда пришёл, страна и город (из заголовков Cloudflare) */
export interface ClickInfo {
  country: string | null;
  city: string | null;
  device: string;
  os: string;
  browser: string;
  referrer: string;
}

const clean = (v: unknown, max: number): string => String(Array.isArray(v) ? v[0] : (v ?? '')).slice(0, max).trim();

function decodeCity(raw: string): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).slice(0, 80) || null;
  } catch {
    return raw.slice(0, 80);
  }
}

export function parseClick(headers: Record<string, unknown>): ClickInfo {
  const ua = clean(headers['user-agent'], 400);
  const l = ua.toLowerCase();
  const bot = /bot|crawler|spider|preview|facebookexternalhit|telegrambot|whatsapp|slurp|curl|python-requests|go-http/i.test(ua);
  const tablet = /ipad|tablet|(android(?!.*mobile))/i.test(ua);
  const mobile = /mobile|iphone|ipod|android/i.test(ua);
  const device = bot ? 'Бот' : tablet ? 'Планшет' : mobile ? 'Телефон' : ua ? 'Компьютер' : 'Неизвестно';

  let os = 'Другая';
  if (/iphone|ipad|ipod|ios/i.test(ua)) os = 'iOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/windows/i.test(ua)) os = 'Windows';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/cros/i.test(ua)) os = 'ChromeOS';
  else if (/linux/i.test(ua)) os = 'Linux';
  if (!ua) os = 'Неизвестно';

  let browser = 'Другой';
  if (/musical_ly|bytedance|tiktok|trill/i.test(ua)) browser = 'TikTok';
  else if (/instagram/i.test(ua)) browser = 'Instagram';
  else if (/fban|fbav|facebook/i.test(ua)) browser = 'Facebook';
  else if (/telegram/i.test(ua)) browser = 'Telegram';
  else if (/edg(e|a|ios)?\//i.test(ua)) browser = 'Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/samsungbrowser/i.test(ua)) browser = 'Samsung Internet';
  else if (/yabrowser/i.test(ua)) browser = 'Яндекс Браузер';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/crios|chrome/i.test(ua)) browser = 'Chrome';
  else if (/safari/i.test(ua)) browser = 'Safari';
  if (!ua) browser = 'Неизвестно';
  void l;

  let referrer = 'Прямой';
  const ref = clean(headers['referer'], 300);
  if (ref) {
    try {
      const h = new URL(ref).hostname.replace(/^www\./, '');
      if (h) referrer = h;
    } catch {
      /* без реферера */
    }
  }

  const cc = clean(headers['cf-ipcountry'], 2).toUpperCase();
  const country = /^[A-Z]{2}$/.test(cc) && !['XX', 'T1'].includes(cc) ? cc : null;
  const city = decodeCity(clean(headers['cf-ipcity'], 120));
  return { country, city, device, os, browser, referrer };
}
