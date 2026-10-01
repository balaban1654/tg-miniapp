import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from './db.js';

/** Применяет schema.sql при старте. Все команды в нём идемпотентны (IF NOT EXISTS). */
export async function migrate(): Promise<void> {
  const candidates = [resolve(process.cwd(), 'schema.sql'), resolve(process.cwd(), '../db/schema.sql')];
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error('schema.sql не найден');
  await db.query(readFileSync(file, 'utf8'));
}
