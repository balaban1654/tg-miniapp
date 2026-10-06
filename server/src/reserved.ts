/** Слова, которые нельзя занять под адрес ссылки: они служебные на корне домена */
export const RESERVED_SLUGS = new Set([
  'office', 'app', 'api', 'health', 'site', 'terms', 'img', 'fonts', 'favicon', 'robots', 'sitemap', 'manifest',
  's', 'b', 'go', 'crm', 'www', 'admin', 'login', 'static', 'assets', 'bot', 'webhook', 'privacy', 'support',
]);
export const SITE_URL = process.env.SITE_URL ?? 'https://hunterai.space';
