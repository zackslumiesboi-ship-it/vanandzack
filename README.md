# vanandzack

Landing page for **Van + Zack the AI editor** — a weekly newsletter about AI tools that move SEO traffic.

## Stack

- Static HTML + CSS. No build step.
- Deployed via Cloudflare Workers → auto-deploys on every push to `main`.
- **Live at:** https://vanzackai.co.za (apex + `www`). Workers default URL `https://vanandzack.zack-slumiesboi.workers.dev/` still works as fallback.

## Edit + ship

```sh
git pull
# edit index.html / style.css
git add -A
git commit -m "your message"
git push
```

Cloudflare rebuilds in ~30 seconds.

## Files

- `index.html` — the page
- `style.css` — styles
- `README.md` — this file

## Subscribe link

The Subscribe CTA points to `https://vanzackai.substack.com` (Substack publication, live as of 2026-04-30).
