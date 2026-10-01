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
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  databaseUrl: need('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),
};
