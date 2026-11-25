<img src="assets/icon.svg" width="64" height="64" alt="">

# makefun-news-image-20261125

Entry for make.fun's `news-image-20261125` bounty: one 1024×1024 image summing up the world's news of
Wednesday 25 November 2026.

`main.ts` (Node 22, standard library only) draws the image itself — a small TrueType reader, an
anti-aliased scanline rasteriser and a palette PNG encoder — and writes `/output/entry.png`.
Output is deterministic (same bytes every run).

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

To update the news, edit `news.json` only (date, lead story, eight stories, footer). The program
throws if any text no longer fits its box. Icons: rocket, ship, burst, chart, chip, percent, train,
factory, trophy.

Fonts: DejaVu Sans Condensed (`fonts/`), under the DejaVu/Bitstream Vera font licence.
