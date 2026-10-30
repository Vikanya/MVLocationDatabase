// Writing content/ JSON the way the Sveltia admin does: 2-space indent, final newline, empty optional fields
// left out. Keys follow the form's field order (read from public/admin/config.yml at build time); in an
// existing file the keys keep their place and new ones go where the form would put them, so later admin saves
// don't reshuffle the file.

/** Field order of one form level; `children` for object fields and the items of list fields. */
export interface Order {
  keys: string[];
  children?: Record<string, Order>;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Drop undefined, '', [] and {} (recursively), like `omit_empty_optional_fields`. */
export function prune(value: unknown): Json | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    const items = value.map(prune).filter((v): v is Json => v !== undefined);
    return items.length ? items : undefined;
  }
  if (isObject(value)) {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = prune(v);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value as Json;
}

/** `value` with its keys in form order; `before` (the file as it was) keeps its own key order. */
export function arrange(value: Json, order: Order | undefined, before?: Json): Json {
  if (Array.isArray(value)) {
    const prev = Array.isArray(before) ? before : [];
    return value.map((item, i) => arrange(item, order, prev[i]));
  }
  if (!isObject(value) || !order) return value;
  const old = isObject(before) ? Object.keys(before).filter((k) => k in value) : [];
  const rank = (k: string) => {
    const i = order.keys.indexOf(k);
    return i === -1 ? order.keys.length : i;
  };
  const keys = [...old];
  for (const k of Object.keys(value).filter((k) => !old.includes(k)).sort((a, b) => rank(a) - rank(b))) {
    // After the last key that comes before it in the form, else first.
    let at = 0;
    keys.forEach((existing, i) => {
      if (rank(existing) <= rank(k)) at = i + 1;
    });
    keys.splice(at, 0, k);
  }
  const out: Record<string, Json> = {};
  for (const k of keys) out[k] = arrange(value[k], order.children?.[k], isObject(before) ? before[k] : undefined);
  return out;
}

/** File text for a record. */
export function serialize(record: unknown, order: Order, before?: unknown): string {
  const value = prune(record) ?? {};
  return `${JSON.stringify(arrange(value, order, before as Json), null, 2)}\n`;
}

/** Form order from the `fields` of a config.yml collection (fields without stored values are harmless). */
export function orderOf(fields: { name: string; fields?: unknown[]; field?: unknown }[]): Order {
  const order: Order = { keys: fields.map((f) => f.name) };
  for (const f of fields) {
    if (Array.isArray(f.fields)) (order.children ??= {})[f.name] = orderOf(f.fields as typeof fields);
  }
  return order;
}
