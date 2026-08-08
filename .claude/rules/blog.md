---
paths:
  - 'blog/**'
  - 'pages/blog/**'
---

# Blog

`blog/*.mdx` → `/blog`, rendered by the custom `pages/blog/index.astro` and `pages/blog/[slug].astro`
(custom pages win over the content route at the same path). Posts need `type: blog` + `date` in
frontmatter; `blog/index.mdx` deliberately has neither so it stays out of the post list.

SEO/GEO conventions, all enforced by `npx blume audit` (run it against `dist/` after `docs:build`):
question-form `##` headings answered in their first sentence, a "short version" bullet list up top, a
"Frequently asked questions" section, `<title>` ≤ 60 chars (use `seo.title` when the H1 is longer),
description 110–160 chars, and enough in-body links that no post is an orphan. `PageLayout` emits no
JSON-LD, so both blog pages build their own schema.org graph. Verify with `npx blume validate`
(internal links) and `npx blume audit`.
