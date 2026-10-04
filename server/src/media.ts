import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Прогоняет файл через ffmpeg и возвращает результат. Бросает ошибку, если ffmpeg нет или не справился. */
export async function ffmpeg(input: Buffer, outExt: string, args: string[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'hunter-'));
  try {
    const inp = join(dir, 'in');
    const out = join(dir, `out.${outExt}`);
    await writeFile(inp, input);
    await new Promise<void>((ok, no) => {
      const p = spawn('ffmpeg', ['-y', '-v', 'error', '-i', inp, ...args, out], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      const t = setTimeout(() => {
        p.kill('SIGKILL');
        no(new Error('ffmpeg: слишком долго'));
      }, 120_000);
      p.on('error', (e) => {
        clearTimeout(t);
        no(e);
      });
      p.on('close', (c) => {
        clearTimeout(t);
        c === 0 ? ok() : no(new Error('ffmpeg: ' + err.slice(0, 300)));
      });
    });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Голосовое для Telegram: OGG/Opus */
export const toVoice = (b: Buffer) => ffmpeg(b, 'ogg', ['-vn', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-t', '1800']);

/** Кружок для Telegram: квадрат по центру, до 640 px, MP4 H.264, не дольше минуты */
export const toVideoNote = (b: Buffer) =>
  ffmpeg(b, 'mp4', [
    '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=480:480',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-t', '60',
  ]);
