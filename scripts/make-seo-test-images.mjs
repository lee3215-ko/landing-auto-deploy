import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const dir = path.resolve('output/seo-test-images');
fs.mkdirSync(dir, { recursive: true });
for (let i = 1; i <= 10; i += 1) {
  const f = path.join(dir, `img-${i}.png`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200">
    <rect width="1200" height="1200" fill="#0c8f80"/>
    <text x="80" y="620" font-size="72" fill="#fff" font-family="Arial">SEO ${i}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(f);
}
console.log('ok', fs.readdirSync(dir).length, dir);
