import { defineConfig } from 'blume';

export default defineConfig({
  title: 'revenue-sdk',
  description:
    'Unified TypeScript SDK for billing providers — Polar, Lemon Squeezy, Stripe, Paddle, Dodo Payments',
  logo: { image: '/logo.svg', text: 'revenue-sdk' },
  theme: {
    accent: { light: 'oklch(0.145 0 0)', dark: 'oklch(0.96 0 0)' },
    radius: 'md',
    mode: 'system',
  },
  github: { owner: 'capawesome-team', repo: 'revenue-sdk', branch: 'main' },
  content: {
    sources: [
      { type: 'filesystem', root: '.', include: ['docs/**/*.{md,mdx}'] },
      {
        type: 'github-releases',
        prefix: 'changelog',
        owner: 'capawesome-team',
        repo: 'revenue-sdk',
      },
    ],
  },
  navigation: {
    repo: true,
    tabs: [
      { label: 'Docs', path: '/docs', icon: 'book-open' },
      { label: 'Changelog', path: '/changelog', icon: 'history' },
    ],
  },
  lastModified: true,
  seo: { rss: { enabled: true, types: ['changelog'] } },
  deployment: { site: 'https://revenue-sdk.dev' },
});
