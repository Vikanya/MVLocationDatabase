// Creates dist/media/thumb/<name> for every full-size screenshot that has no committed thumbnail yet
// (e.g. uploaded through the admin page). Runs after `astro build`; nothing is written to public/.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const FULL = 'dist/media/full';
const THUMB = 'dist/media/thumb';
const WIDTH = 480;
const QUALITY = 80;

mkdirSync(THUMB, { recursive: true });
const missing = readdirSync(FULL).filter((name) => !existsSync(join(THUMB, name)));
for (const name of missing) {
  await sharp(join(FULL, name))
    .resize({ width: WIDTH, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toFile(join(THUMB, name));
}
console.log(`thumbnails: ${missing.length} generated`);
