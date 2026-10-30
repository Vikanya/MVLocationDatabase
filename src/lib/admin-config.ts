// What the quick-add page needs from the admin form definitions (public/admin/config.yml), read at build time
// so the two never drift: the field order of each collection and the fixed list of kinds of place.
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { orderOf, type Order } from '../scripts/quick-add/json.ts';

interface Field {
  name: string;
  widget?: string;
  options?: (string | { value: string })[];
  fields?: Field[];
}
interface Config {
  backend: { repo: string; branch?: string };
  collections: { name: string; fields: Field[] }[];
}

export function adminConfig(path = 'public/admin/config.yml') {
  const config = yaml.load(readFileSync(path, 'utf8')) as Config;
  const fields = (name: string) => config.collections.find((c) => c.name === name)!.fields;
  const tags = fields('locations').find((f) => f.name === 'tags')?.options ?? [];
  return {
    repo: config.backend.repo,
    branch: config.backend.branch ?? 'main',
    order: { videos: orderOf(fields('videos')), locations: orderOf(fields('locations')), artists: orderOf(fields('artists')) } as Record<
      'videos' | 'locations' | 'artists',
      Order
    >,
    tags: tags.map((t) => (typeof t === 'string' ? t : t.value)),
  };
}
