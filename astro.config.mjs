// @ts-check
import { defineConfig } from 'astro/config';

// On GitHub Pages the site lives under /<repo>/; the deploy workflow sets these.
export default defineConfig({
  site: process.env.SITE_URL || 'http://localhost:4321',
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
