/**
 * 넷리파이 SEO 사이트: 사용자 이미지 폴더에서 랜덤 선택 → assets에 배치
 * 폴더가 비어 있으면 엔진이 만든 생성 이미지를 그대로 둠
 */
import fs from 'fs';
import path from 'path';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

function listImages(dir) {
  const root = path.resolve(String(dir || '').trim());
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  const walk = (d, depth = 0) => {
    if (depth > 2) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (IMAGE_EXT.test(ent.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function pickRandom(arr) {
  if (!arr?.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function loadSharp() {
  try {
    const mod = await import('sharp');
    return mod.default || mod;
  } catch {
    return null;
  }
}

async function writeVariant(sharp, srcPath, destPath, { width, height, fit = 'cover' }) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (sharp) {
    await sharp(srcPath)
      .rotate()
      .resize(width, height, { fit, position: 'centre' })
      .webp({ quality: 86 })
      .toFile(destPath.replace(/\.png$/i, '.webp'));
    // also png fallback if engine expects png
    const pngPath = destPath.replace(/\.webp$/i, '.png');
    await sharp(srcPath)
      .rotate()
      .resize(width, height, { fit, position: 'centre' })
      .png()
      .toFile(pngPath);
    return;
  }
  fs.copyFileSync(srcPath, destPath);
}

/**
 * @param {object} opts
 * @param {string} opts.siteDir 생성된 사이트 루트
 * @param {string} opts.imageDir 사용자 이미지 폴더
 * @param {function} [opts.onLog]
 * @returns {{ used: boolean, count: number, reason?: string }}
 */
export async function applyRandomImagesFromFolder({ siteDir, imageDir, onLog } = {}) {
  const log = (m) => { if (typeof onLog === 'function') onLog(m); };
  const dir = String(imageDir || '').trim();
  const site = String(siteDir || '').trim();
  if (!site || !fs.existsSync(site)) {
    return { used: false, count: 0, reason: 'site_missing' };
  }
  if (!dir) {
    return { used: false, count: 0, reason: 'no_folder' };
  }

  const pool = listImages(dir);
  if (!pool.length) {
    log(`이미지 폴더에 사용 가능한 파일이 없어 자동 생성 이미지를 유지합니다: ${dir}`);
    return { used: false, count: 0, reason: 'empty' };
  }

  const sharp = await loadSharp();
  const assets = path.join(site, 'assets');
  const thumbDir = path.join(assets, 'thumb');
  const heroDir = path.join(assets, 'hero');
  const ogDir = path.join(assets, 'og');
  fs.mkdirSync(thumbDir, { recursive: true });
  fs.mkdirSync(heroDir, { recursive: true });
  fs.mkdirSync(ogDir, { recursive: true });

  // topic slugs from existing thumb files or subdirs with index.html
  let slugs = [];
  try {
    slugs = fs.readdirSync(thumbDir)
      .map((f) => f.replace(/\.(webp|png|jpe?g)$/i, ''))
      .filter((s, i, a) => s && a.indexOf(s) === i);
  } catch { /* ignore */ }
  if (!slugs.length) {
    try {
      slugs = fs.readdirSync(site, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !['assets', '.ai-cache'].includes(d.name))
        .filter((d) => fs.existsSync(path.join(site, d.name, 'index.html')))
        .map((d) => d.name);
    } catch { /* ignore */ }
  }

  let n = 0;
  const usedSrc = new Set();
  const pick = () => {
    // prefer unused until pool exhausted
    const fresh = pool.filter((p) => !usedSrc.has(p));
    const src = pickRandom(fresh.length ? fresh : pool);
    if (src) usedSrc.add(src);
    return src;
  };

  for (const slug of slugs) {
    const src = pick();
    if (!src) break;
    // 롱폼 미리보기 경로: assets/{slug}.webp
    await writeVariant(sharp, src, path.join(assets, `${slug}.webp`), { width: 800, height: 800 });
    await writeVariant(sharp, src, path.join(thumbDir, `${slug}.webp`), { width: 800, height: 800 });
    await writeVariant(sharp, src, path.join(heroDir, `${slug}.webp`), { width: 1200, height: 630, fit: 'cover' });
    n += 1;
  }

  const ogSrc = pick() || pickRandom(pool);
  if (ogSrc) {
    await writeVariant(sharp, ogSrc, path.join(ogDir, 'cover.webp'), { width: 1200, height: 630 });
    await writeVariant(sharp, ogSrc, path.join(assets, 'og-cover.webp'), { width: 1200, height: 630 });
    n += 1;
  }

  log(`✔ 이미지 폴더에서 ${pool.length}장 중 랜덤 적용 (${slugs.length}토픽 + OG)`);
  return { used: true, count: n, pool: pool.length };
}
