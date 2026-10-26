// Rasterise public/icon.svg into the PNG icons used for the home screen and manifest.
// Usage: node scripts/icons.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const svg = readFileSync('public/icon.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
// [file, size, inner scale] — maskable icons keep the art inside the central safe zone.
for (const [file, size, scale] of [
  ['public/apple-touch-icon.png', 180, 1],
  ['public/icon-192.png', 192, 1],
  ['public/icon-512.png', 512, 1],
  ['public/icon-maskable-512.png', 512, 0.8],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:#120f0c;display:grid;place-items:center;width:${size}px;height:${size}px">` +
      `<div style="width:${size * scale}px;height:${size * scale}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body>`,
  );
  await page.screenshot({ path: file, omitBackground: false });
  console.log(file);
}
await browser.close();
