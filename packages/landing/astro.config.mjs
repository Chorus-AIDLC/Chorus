// @ts-check
import { defineConfig } from 'astro/config';
import rehypeExternalLinks from 'rehype-external-links';

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://chorus-ai.dev',
  output: 'static',

  markdown: {
    rehypePlugins: [
      [rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }],
    ],
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh'],
    routing: {
      prefixDefaultLocale: false,
    },
  },

  integrations: [sitemap()],
});