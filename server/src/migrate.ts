import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from './db.js';

/** Применяет schema.sql при старте. Все команды в нём идемпотентны (IF NOT EXISTS). */
export async function migrate(): Promise<void> {
  const candidates = [resolve(process.cwd(), 'schema.sql'), resolve(process.cwd(), '../db/schema.sql')];
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error('schema.sql не найден');
  await db.query(readFileSync(file, 'utf8'));
  await signalImages();
}

/** Разово: картинки «Вверх» и «Вниз» в шаблон «Новый сигнал» (файлы public/img/signal-up.jpg, signal-down.jpg).
 *  Метка меняется, когда картинки перерисованы: signal_img_2 — график только свечами и точкой входа (вариант Б) */
async function signalImages(): Promise<void> {
  if ((await db.query(`SELECT 1 FROM app_settings WHERE key = 'signal_img_2'`)).rowCount) return;
  const up = resolve(process.cwd(), 'public/img/signal-up.jpg');
  const down = resolve(process.cwd(), 'public/img/signal-down.jpg');
  if (!existsSync(up) || !existsSync(down)) return;
  const r = await db.query(
    `UPDATE push_templates SET photo = $1, photo_type = 'image/jpeg', photo_down = $2, photo_down_type = 'image/jpeg', updated_at = now() WHERE key = 'signal'`,
    [readFileSync(up), readFileSync(down)],
  );
  if (r.rowCount) await db.query(`INSERT INTO app_settings (key, value) VALUES ('signal_img_2', '1') ON CONFLICT (key) DO NOTHING`);
}
