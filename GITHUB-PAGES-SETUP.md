# Publish mcp-spec-nav on GitHub Pages

1. Copy the `docs/` directory into `khoitd-voyager/mcp-spec-nav` and commit it.
2. In the repository, open **Settings → Pages**.
3. Select **Deploy from a branch**, branch **main**, folder **/docs**, and save.

Language URLs:

- English: https://khoitd-voyager.github.io/mcp-spec-nav/
- Vietnamese: https://khoitd-voyager.github.io/mcp-spec-nav/vi/
- Chinese: https://khoitd-voyager.github.io/mcp-spec-nav/zh/

Each page has its own rendered content, canonical URL, reciprocal hreflang tags,
localized Open Graph metadata, and software structured data. The generated cover
is included at `docs/assets/social-preview.png`.

## Sitemap and Search Console

The sitemap is https://khoitd-voyager.github.io/mcp-spec-nav/sitemap.xml.
After the site is published, verify the URL-prefix property in Google Search
Console, submit this sitemap, and inspect the three page URLs.
Verification requires a Google-provided HTML file or meta tag; no verification
token has been fabricated or inserted.

## robots.txt on a GitHub project site

Crawlers only read https://khoitd-voyager.github.io/robots.txt.
They do not use /mcp-spec-nav/robots.txt as the domain's robots file.
The `docs/robots.txt` file is a ready-to-copy template. Add or merge its rules
and sitemap line into the root publishing directory of your separate
`khoitd-voyager.github.io` user-site repository. Preserve any existing rules.
A robots file is not required for these pages to be eligible for indexing.

## Updating the pages

The source English page is `docs/index.html`; the translation dictionary is in
its script. Edit the English source and dictionary, then run:

```sh
python scripts/build-pages.py
```

Commit the regenerated `docs/` files. The build script uses only Python's
standard library. GitHub Pages needs no build step because the output is static.
When moving to another host or a custom domain, update `BASE` in the script and
regenerate before publishing.

Benchmark data is embedded from the recorded JSON reports, dated 2026-10-13.
The charts describe deterministic agents, not measured live-LLM performance.
