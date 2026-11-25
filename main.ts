// news-image-20261125: draws one day's world news (news.json) as a flat-colour 1024x1024 PNG at /output/entry.png.
// Node 22, standard library only: a small TrueType reader + scanline rasteriser + PNG encoder. Deterministic.
// Local run: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// To swap the news, edit news.json only; the layout throws if any text no longer fits.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

type Pt = [number, number];
type RGB = [number, number, number];
type Item = { tag: string; color: string; icon: string; head: string; body: string };

const file = (p: string) => readFileSync(new URL(p, import.meta.url));
const news: { date: string; kicker: string; footer: string; lead: Item; stories: Item[] } = JSON.parse(file('./news.json').toString('utf8'));

// ---------------- TrueType (glyf outlines, cmap format 4) ----------------
function loadFont(b: Buffer) {
  const t: Record<string, number> = {};
  for (let i = 0; i < b.readUInt16BE(4); i++) t[b.toString('latin1', 12 + 16 * i, 16 + 16 * i)] = b.readUInt32BE(20 + 16 * i);
  const upm = b.readUInt16BE(t.head + 18), longLoca = b.readInt16BE(t.head + 50) === 1;
  const numHM = b.readUInt16BE(t.hhea + 34);
  const loca = (g: number) => (longLoca ? b.readUInt32BE(t.loca + 4 * g) : b.readUInt16BE(t.loca + 2 * g) * 2);
  let sub = 0;
  for (let i = 0; i < b.readUInt16BE(t.cmap + 2); i++) {
    const r = t.cmap + 4 + 8 * i;
    if (b.readUInt16BE(r) === 3 && b.readUInt16BE(r + 2) === 1) sub = t.cmap + b.readUInt32BE(r + 4);
  }
  const segX2 = b.readUInt16BE(sub + 6), ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
  const gid = (cp: number) => {
    for (let s = 0; s < segX2; s += 2) {
      if (b.readUInt16BE(ends + s) < cp) continue;
      const st = b.readUInt16BE(starts + s), ro = b.readUInt16BE(ranges + s);
      if (st > cp) return 0;
      if (!ro) return (cp + b.readInt16BE(deltas + s)) & 0xffff;
      const g = b.readUInt16BE(ranges + s + ro + (cp - st) * 2);
      return g ? (g + b.readInt16BE(deltas + s)) & 0xffff : 0;
    }
    return 0;
  };
  const adv = (g: number) => b.readUInt16BE(t.hmtx + 4 * Math.min(g, numHM - 1));
  const outline = (g: number): Pt[][] => {
    const off = t.glyf + loca(g);
    if (off === t.glyf + loca(g + 1)) return [];
    const nc = b.readInt16BE(off);
    const out: Pt[][] = [];
    if (nc < 0) {
      let p = off + 10, flags: number;
      do {
        flags = b.readUInt16BE(p);
        const sub = b.readUInt16BE(p + 2);
        p += 4;
        let dx: number, dy: number;
        if (flags & 1) { dx = b.readInt16BE(p); dy = b.readInt16BE(p + 2); p += 4; }
        else { dx = b.readInt8(p); dy = b.readInt8(p + 1); p += 2; }
        // shortcut: component scale/2x2 transforms are skipped (unused by the ASCII glyphs drawn here); apply them if accented text is added.
        p += flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0;
        for (const c of outline(sub)) out.push(c.map(([x, y]): Pt => [x + dx, y + dy]));
      } while (flags & 0x20);
      return out;
    }
    const endPts = Array.from({ length: nc }, (_, i) => b.readUInt16BE(off + 10 + 2 * i));
    const n = endPts[nc - 1] + 1;
    let p = off + 12 + 2 * nc + b.readUInt16BE(off + 10 + 2 * nc);
    const fl: number[] = [];
    while (fl.length < n) {
      const f = b[p++];
      fl.push(f);
      if (f & 8) for (let r = b[p++]; r > 0; r--) fl.push(f);
    }
    const coords = (short: number, same: number) => {
      const v: number[] = [];
      let c = 0;
      for (const f of fl) {
        if (f & short) { const d = b[p++]; c += f & same ? d : -d; }
        else if (!(f & same)) { c += b.readInt16BE(p); p += 2; }
        v.push(c);
      }
      return v;
    };
    const xs = coords(2, 16), ys = coords(4, 32);
    let s = 0;
    for (const e of endPts) {
      const pts = [];
      for (let i = s; i <= e; i++) pts.push({ x: xs[i], y: ys[i], on: (fl[i] & 1) === 1 });
      out.push(flattenQuad(pts));
      s = e + 1;
    }
    return out;
  };
  return { upm, gid, adv, outline };
}

type QP = { x: number; y: number; on: boolean };
function flattenQuad(pts: QP[]): Pt[] {
  const mid = (a: QP, c: QP): QP => ({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2, on: true });
  const k = pts.findIndex((q) => q.on);
  const seq = k < 0 ? [mid(pts[pts.length - 1], pts[0]), ...pts] : [...pts.slice(k), ...pts.slice(0, k)];
  seq.push(seq[0]);
  const out: Pt[] = [[seq[0].x, seq[0].y]];
  let prev = seq[0];
  for (let i = 1; i < seq.length; i++) {
    const c = seq[i];
    if (c.on) { out.push([c.x, c.y]); prev = c; continue; }
    const nx = seq[i + 1];
    const end = nx.on ? nx : mid(c, nx);
    for (let j = 1; j <= 8; j++) {
      const u = j / 8, v = 1 - u;
      out.push([v * v * prev.x + 2 * u * v * c.x + u * u * end.x, v * v * prev.y + 2 * u * v * c.y + u * u * end.y]);
    }
    prev = end;
    if (nx.on) i++;
  }
  return out;
}

const bold = loadFont(file('./fonts/DejaVuSansCondensed-Bold.ttf'));
const book = loadFont(file('./fonts/DejaVuSansCondensed.ttf'));
type Font = typeof bold;

// ---------------- Canvas: anti-aliased non-zero fill on a flat RGB buffer ----------------
const W = 1024, H = 1024, SUB = 5, LEVELS = 8; // coverage is snapped to 8 levels so the PNG palette stays small
const img = new Uint8Array(W * H * 3);
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;

function rect(x: number, y: number, w: number, h: number, c: RGB) {
  for (let j = Math.max(0, y); j < Math.min(H, y + h); j++)
    for (let i = Math.max(0, x); i < Math.min(W, x + w); i++) img.set(c, (j * W + i) * 3);
}

function fill(polys: Pt[][], c: RGB) {
  const edges: number[][] = [];
  let y0 = H, y1 = 0;
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      if (ay !== by) edges.push([ax, ay, bx, by]);
      y0 = Math.min(y0, ay); y1 = Math.max(y1, ay);
    }
  const cov = new Float32Array(W + 1);
  const span = (a: number, b: number) => {
    a = Math.max(0, a); b = Math.min(W, b);
    if (b <= a) return;
    const ia = Math.floor(a), ib = Math.floor(b);
    if (ia === ib) { cov[ia] += b - a; return; }
    cov[ia] += ia + 1 - a;
    for (let i = ia + 1; i < ib; i++) cov[i] += 1;
    cov[ib] += b - ib;
  };
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
    cov.fill(0);
    for (let s = 0; s < SUB; s++) {
      const sy = y + (s + 0.5) / SUB;
      const xs: Pt[] = [];
      for (const [ax, ay, bx, by] of edges)
        if (sy >= ay !== sy >= by) xs.push([ax + ((sy - ay) * (bx - ax)) / (by - ay), by > ay ? 1 : -1]);
      xs.sort((p, q) => p[0] - q[0]);
      let wind = 0;
      for (let k = 0; k < xs.length - 1; k++) if ((wind += xs[k][1]) !== 0) span(xs[k][0], xs[k + 1][0]);
    }
    for (let x = 0; x < W; x++) {
      const a = Math.round(Math.min(1, cov[x] / SUB) * LEVELS) / LEVELS;
      if (!a) continue;
      const o = (y * W + x) * 3;
      for (let k = 0; k < 3; k++) img[o + k] = Math.round(img[o + k] + (c[k] - img[o + k]) * a);
    }
  }
}

const circle = (cx: number, cy: number, r: number): Pt[] =>
  Array.from({ length: 64 }, (_, i): Pt => [cx + r * Math.cos((i * Math.PI) / 32), cy + r * Math.sin((i * Math.PI) / 32)]);

function roundRect(x: number, y: number, w: number, h: number, r: number): Pt[] {
  const p: Pt[] = [];
  const corners: Pt[] = [[x + w - r, y + r], [x + w - r, y + h - r], [x + r, y + h - r], [x + r, y + r]];
  corners.forEach(([cx, cy], k) => {
    for (let i = 0; i <= 8; i++) {
      const a = ((k - 1) * Math.PI) / 2 + (i * Math.PI) / 16;
      p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  });
  return p;
}

// ---------------- Text ----------------
const width = (f: Font, s: string, size: number) => [...s].reduce((w, ch) => w + f.adv(f.gid(ch.codePointAt(0)!)), 0) * (size / f.upm);

function text(f: Font, s: string, x: number, base: number, size: number, c: RGB) {
  const sc = size / f.upm, polys: Pt[][] = [];
  for (const ch of s) {
    const g = f.gid(ch.codePointAt(0)!);
    if (!g && ch !== ' ') throw new Error(`no glyph for ${JSON.stringify(ch)}`);
    for (const con of f.outline(g)) polys.push(con.map(([px, py]): Pt => [x + px * sc, base - py * sc]));
    x += f.adv(g) * sc;
  }
  fill(polys, c);
}

function wrap(f: Font, s: string, size: number, maxW: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const word of s.split(' ')) {
    const last = lines[lines.length - 1];
    if (last !== undefined && width(f, `${last} ${word}`, size) <= maxW) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  if (lines.length > maxLines || lines.some((l) => width(f, l, size) > maxW))
    throw new Error(`does not fit in ${maxLines} line(s) of ${maxW}px at ${size}px: ${s}`);
  return lines;
}

// ---------------- Icons: white symbols on a coloured disc, drawn in a -50..50 box ----------------
const WHITE: RGB = [255, 255, 255];
function icon(name: string, cx: number, cy: number, r: number, c: RGB) {
  fill([circle(cx, cy, r)], c);
  const k = r / 50;
  const P = (...v: number[]): Pt[] => Array.from({ length: v.length / 2 }, (_, i): Pt => [cx + v[2 * i] * k, cy + v[2 * i + 1] * k]);
  const R = (x: number, y: number, w: number, h: number) => P(x, y, x + w, y, x + w, y + h, x, y + h);
  const hole = (polys: Pt[][]) => fill(polys, c);
  const sym: Record<string, () => void> = {
    rocket: () => {
      fill([P(0, -38, 12, -22, 12, 18, -12, 18, -12, -22), P(-12, 2, -25, 24, -12, 18), P(12, 2, 25, 24, 12, 18), P(-7, 22, 7, 22, 0, 38)], WHITE);
      hole([circle(cx, cy - 6 * k, 6 * k)]);
    },
    ship: () => fill([P(-36, 4, 36, 4, 26, 22, -28, 22), R(-24, -10, 30, 14), R(-16, -24, 9, 14), P(-40, 30, 40, 30, 40, 34, -40, 34)], WHITE),
    burst: () => fill([Array.from({ length: 20 }, (_, i): Pt => {
      const a = (i * Math.PI) / 10, rr = (i % 2 ? 15 : 36) * k;
      return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
    })], WHITE),
    chart: () => fill([R(-30, 12, 14, 18), R(-9, 0, 14, 30), R(12, -14, 14, 44), P(-34, -6, 10, -30, 6, -36, 22, -36, 18, -22, 14, -26, -30, -2)], WHITE),
    chip: () => {
      const pins: Pt[][] = [];
      for (const d of [-12, 0, 12]) pins.push(R(d - 3, -32, 6, 64), R(-32, d - 3, 64, 6));
      fill([...pins, R(-22, -22, 44, 44)], WHITE);
      hole([R(-11, -11, 22, 22)]);
    },
    percent: () => {
      const s = 62 * k;
      text(bold, '%', cx - width(bold, '%', s) / 2, cy + s * 0.36, s, WHITE);
    },
    train: () => {
      fill([roundRect(cx - 24 * k, cy - 32 * k, 48 * k, 52 * k, 9 * k), P(-16, 20, -8, 20, -16, 34, -24, 34), P(16, 20, 8, 20, 16, 34, 24, 34)], WHITE);
      hole([R(-17, -24, 14, 14), R(3, -24, 14, 14), circle(cx - 12 * k, cy + 8 * k, 4 * k), circle(cx + 12 * k, cy + 8 * k, 4 * k)]);
    },
    factory: () => fill([P(-36, 30, -36, -4, -20, 6, -20, -4, -4, 6, -4, -4, 12, 6, 12, -34, 26, -34, 26, 30)], WHITE),
    trophy: () => fill([
      P(-20, -30, 20, -30, 18, -8, 8, 4, 4, 14, 4, 20, 14, 24, 14, 30, -14, 30, -14, 24, -4, 20, -4, 14, -8, 4, -18, -8),
      P(-20, -28, -34, -28, -30, -12, -18, -6, -18, -12, -24, -14, -26, -22, -20, -22),
      P(20, -28, 34, -28, 30, -12, 18, -6, 18, -12, 24, -14, 26, -22, 20, -22),
    ], WHITE),
  };
  if (!sym[name]) throw new Error(`unknown icon ${name}`);
  sym[name]();
}

// ---------------- Layout ----------------
const BG = hex('#ECE8DE'), NAVY = hex('#15213B'), GOLD = hex('#F2C14E'), CARD = WHITE, INK = hex('#161616'), GREY = hex('#4A4A4A');
rect(0, 0, W, H, BG);
rect(0, 0, W, 118, NAVY);
text(bold, news.kicker, 32, 40, 21, GOLD);
wrap(bold, news.date, 54, W - 64, 1);
text(bold, news.date, 32, 96, 54, WHITE);

function card(it: Item, x: number, y: number, w: number, h: number, r: number, sz: { tag: number; head: number; body: number; headLines: number }) {
  fill([roundRect(x, y, w, h, 12)], CARD);
  const c = hex(it.color);
  icon(it.icon, x + 16 + r, y + 18 + r, r, c);
  const tx = x + 2 * r + 30, tw = x + w - 16 - tx;
  let base = y + 18 + sz.tag;
  text(bold, it.tag, tx, base, sz.tag, c);
  const head = wrap(bold, it.head, sz.head, tw, sz.headLines);
  for (const l of head) text(bold, l, tx, (base += sz.head * 1.15), sz.head, INK);
  base += 4;
  const left = Math.floor((y + h - 10 - base) / (sz.body * 1.22));
  for (const l of wrap(book, it.body, sz.body, tw, left)) text(book, l, tx, (base += sz.body * 1.22), sz.body, GREY);
}

card(news.lead, 24, 132, W - 48, 150, 56, { tag: 18, head: 31, body: 20, headLines: 1 });
const cols = 2, gap = 12, cw = (W - 48 - gap) / cols, ch = 164;
news.stories.forEach((it, i) =>
  card(it, 24 + (i % cols) * (cw + gap), 296 + Math.floor(i / cols) * (ch + gap), cw, ch, 32, { tag: 15, head: 27, body: 18, headLines: 2 }),
);
wrap(book, news.footer, 15, W - 48, 1);
text(book, news.footer, 24, 1012, 15, GREY);

// ---------------- PNG (palette when <= 256 colours, else RGB) ----------------
const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const v of buf) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer) {
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(td.length + 8);
  out.writeUInt32BE(data.length, 0);
  td.copy(out, 4);
  out.writeUInt32BE(crc32(td), td.length + 4);
  return out;
}

const palette = new Map<number, number>();
for (let i = 0; i < W * H && palette.size <= 256; i++) {
  const v = (img[3 * i] << 16) | (img[3 * i + 1] << 8) | img[3 * i + 2];
  if (!palette.has(v)) palette.set(v, palette.size);
}
const indexed = palette.size <= 256;
const bpp = indexed ? 1 : 3;
const raw = Buffer.alloc(H * (W * bpp + 1));
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const o = y * (W * bpp + 1) + 1 + x * bpp, s = (y * W + x) * 3;
    if (indexed) raw[o] = palette.get((img[s] << 16) | (img[s + 1] << 8) | img[s + 2])!;
    else raw.set(img.subarray(s, s + 3), o);
  }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr.set([8, indexed ? 3 : 2, 0, 0, 0], 8);
const plte = Buffer.from([...palette.keys()].flatMap((v) => [v >> 16, (v >> 8) & 255, v & 255]));
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  ...(indexed ? [chunk('PLTE', plte)] : []),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
if (png.length > 1048576) throw new Error(`entry.png is ${png.length} bytes, over 1 MiB`);
writeFileSync(join(process.env.MAKEFUN_OUTPUT_DIR ?? '/output', 'entry.png'), png);
console.log(`entry.png ${W}x${H}, ${png.length} bytes, ${indexed ? `${palette.size}-colour palette` : 'RGB'}`);
