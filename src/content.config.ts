import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Keep file names exactly as IDs: YouTube IDs are case-sensitive and the default loader lowercases them.
const fileId = ({ entry }: { entry: string }) => entry.replace(/\.json$/, '');
const from = (folder: string) => glob({ pattern: '*.json', base: `./content/${folder}`, generateId: fileId });

const artists = defineCollection({
  loader: from('artists'),
  schema: z.object({
    name: z.string(),
    name_ko: z.string().optional(),
    /** Groups this artist belongs to (member → group, sub-unit → group). Videos use the most precise artist. */
    part_of: z.array(reference('artists')).optional(),
    review: z.array(z.string()).optional(),
  }),
});

const locations = defineCollection({
  loader: from('locations'),
  schema: z.object({
    name: z.string(),
    status: z.enum(['identified', 'unknown']),
    address: z.string().optional(),
    coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
    coordinates_source: z.string().optional(),
    links: z
      .object({
        google_maps: z.array(z.string()).optional(),
        naver_map: z.array(z.string()).optional(),
        website: z.array(z.string()).optional(),
        instagram: z.array(z.string()).optional(),
      })
      .optional(),
    reference_videos: z.array(z.string()).optional(),
    photos: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    sets: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
    notes: z.string().optional(),
    review: z.array(z.string()).optional(),
    sheet_rows: z.array(z.string()).optional(),
  }),
});

const videos = defineCollection({
  loader: from('videos'),
  schema: z.object({
    title: z.string(),
    platform: z.enum(['youtube', 'instagram_post', 'imgur']),
    url: z.string(),
    artists: z.array(reference('artists')).optional(),
    /** Official Latin title of the song (empty if it only has a Korean title). */
    song: z.string().optional(),
    /** Korean (Hangul) title of the song. */
    song_ko: z.string().optional(),
    type: z.enum(['mv', 'performance', 'live', 'cover', 'clip', 'other']).optional(),
    channel: z.string().optional(),
    embeddable: z.boolean().optional(),
    start: z.number().optional(),
    appearances: z
      .array(
        z.object({
          location: reference('locations'),
          screenshots: z.array(z.object({ image: z.string(), set: z.string().optional() })).optional(),
          confidence: z.string().optional(),
          notes: z.string().optional(),
          sheet_rows: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    review: z.array(z.string()).optional(),
  }),
});

export const collections = { artists, locations, videos };
