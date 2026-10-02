import 'dotenv/config';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная ${name}. Смотрите .env.example`);
  return v;
}

export const config = {
  botToken: need('BOT_TOKEN'),
  botUsername: process.env.BOT_USERNAME ?? 'hunters_aibot',
  miniAppUrl: process.env.MINIAPP_URL ?? '',
  termsUrl: process.env.TERMS_URL ?? 'https://hunterai.space/terms',
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  databaseUrl: need('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  defaultPoLink: process.env.DEFAULT_PO_LINK ?? '',
  defaultPoLinkRu: process.env.DEFAULT_PO_LINK_RU ?? '',
  pushTz: process.env.PUSH_TZ ?? 'Europe/Kyiv',
  pushDayFrom: Number(process.env.PUSH_DAY_FROM ?? 10),
  pushDayTo: Number(process.env.PUSH_DAY_TO ?? 22),
  postbackSecret: process.env.POSTBACK_SECRET ?? '',
  disableBot: process.env.DISABLE_BOT === '1',
  adminLogin: process.env.ADMIN_LOGIN ?? '',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  secureCookies: process.env.NODE_ENV === 'production',
};
