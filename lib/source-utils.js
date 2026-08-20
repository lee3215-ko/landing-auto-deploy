import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { extractZip } from './deploy.js';

const INDEX_NAME_RE = /^(index\.html?|index_[^\\/]+\.html)$/i;
const MAX_INDEX_DEPTH = 5;

export function extractTitleFromHtml(html) {
  if (!html) return '';
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return m[1]
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * index.html / index.htm / index_*.html 을 depth 제한으로 탐색
 * @returns {string|null} dir 기준 상대 경로
 */
export function findIndexHtmlRelative(dir, maxDepth = MAX_INDEX_DEPTH) {
  if (!dir || !fs.existsSync(dir)) return null;

  function walk(current, relPrefix, depth) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }

    // 현재 폴더 파일 우선
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const exact = files.find((f) => /^index\.html?$/i.test(f));
    if (exact) return relPrefix ? `${relPrefix}/${exact}` : exact;
    const named = files.find((f) => /^index_[^\\/]+\.html$/i.test(f));
    if (named) return relPrefix ? `${relPrefix}/${named}` : named;

    if (depth >= maxDepth) return null;

    // 얕은 폴더부터 (이름 짧은 순)
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const ent of dirs) {
      const nextRel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const hit = walk(path.join(current, ent.name), nextRel, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  return walk(dir, '', 0);
}

/** ZIP 내 index 경로 찾기 (깊이 제한) */
export async function findIndexHtmlInZipBuffer(data) {
  const zip = await JSZip.loadAsync(data);
  return findIndexHtmlInZip(zip);
}

async function findIndexHtmlInZip(zip) {
  const names = Object.keys(zip.files)
    .filter((n) => !zip.files[n].dir)
    .map((n) => n.replace(/\\/g, '/'));

  const scored = [];
  for (const n of names) {
    const base = n.split('/').pop() || '';
    if (!INDEX_NAME_RE.test(base) && !/^index\.html?$/i.test(base)) continue;
    const depth = n.split('/').filter(Boolean).length - 1;
    if (depth > MAX_INDEX_DEPTH) continue;
    const exactBonus = /^index\.html?$/i.test(base) ? 0 : 10;
    scored.push({ n, score: depth * 10 + exactBonus });
  }
  if (!scored.length) {
    // 관대한 매칭: 경로 끝 index.html
    const loose = names.find((n) => /(^|\/)index\.html?$/i.test(n));
    return loose || null;
  }
  scored.sort((a, b) => a.score - b.score);
  return scored[0].n;
}

/** 배포 전 ZIP 사전 검사 (압축 해제 없이) */
export async function validateZipHasIndex(zipPath) {
  try {
    if (!zipPath || !fs.existsSync(zipPath)) {
      return { ok: false, error: 'ZIP 파일이 없습니다.' };
    }
    const data = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(data);
    const rel = await findIndexHtmlInZip(zip);
    if (!rel) {
      return {
        ok: false,
        error: 'ZIP 안에 index.html(또는 index.htm)이 없습니다. 루트~하위 5단계 안에 넣어 주세요.',
      };
    }
    return { ok: true, indexRel: rel };
  } catch (e) {
    return { ok: false, error: e.message || 'ZIP 검사 실패' };
  }
}

/** ZIP 압축 해제 후 index.html이 있는 실제 사이트 루트 폴더 반환 */
export async function resolveZipSiteDir(zipPath, extractTo) {
  const pre = await validateZipHasIndex(zipPath);
  if (!pre.ok) {
    throw new Error(pre.error || 'ZIP 파일에서 index.html을 찾을 수 없습니다.');
  }

  await extractZip(zipPath, extractTo);
  const rel = findIndexHtmlRelative(extractTo);
  if (!rel) {
    throw new Error(
      'ZIP 파일에서 index.html을 찾을 수 없습니다. (루트 또는 하위 폴더에 index.html / index.htm 필요)',
    );
  }
  const htmlDir = path.dirname(rel) === '.'
    ? extractTo
    : path.join(extractTo, path.dirname(rel));
  return { htmlDir, indexRel: rel };
}

export function getTitleFromFolder(folderPath) {
  const rel = findIndexHtmlRelative(folderPath);
  if (!rel) return '';
  const html = fs.readFileSync(path.join(folderPath, rel), 'utf8');
  return extractTitleFromHtml(html);
}

export async function getTitleFromZip(zipPath) {
  const data = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(data);
  const rel = await findIndexHtmlInZip(zip);
  if (!rel) return '';
  const html = await zip.file(rel).async('string');
  return extractTitleFromHtml(html);
}

export async function getTitleFromSource(source, tempRoot = null) {
  if (!source?.path) return '';
  if (source.type === 'folder') {
    return getTitleFromFolder(source.path);
  }
  if (source.type === 'zip') {
    return getTitleFromZip(source.path);
  }
  return '';
}

export function fallbackSourceName(source) {
  if (!source?.name) return '사이트';
  return source.name.replace(/\.zip$/i, '');
}

/**
 * ZIP 경로 해석 — 원본 없으면 같은 폴더 `성공/` 아래 동명 파일 허용.
 * @returns {string} 존재하는 경로, 없으면 빈 문자열
 */
export function resolveExistingZipPath(zipPath = '') {
  const raw = String(zipPath || '').trim();
  if (!raw) return '';
  if (fs.existsSync(raw)) return raw;
  try {
    const dir = path.dirname(raw);
    const base = path.basename(raw);
    const inSuccess = path.join(dir, '성공', base);
    if (fs.existsSync(inSuccess)) return inSuccess;
    // 이미 성공 폴더 경로인데 상위가 바뀐 경우
    if (/성공$/i.test(path.basename(dir)) && fs.existsSync(path.join(dir, base))) {
      return path.join(dir, base);
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * 닷홈 배포 전: ZIP/폴더 HTML·sitemap·robots의 공개 URL을 `{ftpId}.dothome.co.kr`로 맞춤.
 * ZIP 템플릿의 `__SITE_URL__` 등 플레이스홀더도 치환한다.
 * @returns {{ htmlFiles: number, sitemap: boolean, robots: boolean }}
 */
export function rewriteSitePublicUrls(siteDir, siteRootUrl, sendLog = null) {
  const log = (m) => {
    if (typeof sendLog === 'function') sendLog(m);
  };
  const dir = String(siteDir || '').trim();
  const root = String(siteRootUrl || '').replace(/\/$/, '');
  if (!dir || !root || !fs.existsSync(dir)) {
    return { htmlFiles: 0, sitemap: false, robots: false };
  }

  let host = '';
  try { host = new URL(root).host; } catch { host = ''; }
  const absRoot = root;

  /** 템플릿 플레이스홀더 → 실제 사이트 루트 (끝 슬래시 없음) */
  const replacePlaceholders = (text) => {
    let out = String(text || '');
    // __SITE_URL__ / {{SITE_URL}} / %SITE_URL% / {SITE_URL}
    out = out.replace(/__SITE_URL__/gi, absRoot);
    out = out.replace(/\{\{\s*SITE_URL\s*\}\}/gi, absRoot);
    out = out.replace(/%SITE_URL%/gi, absRoot);
    out = out.replace(/\{\s*SITE_URL\s*\}/gi, absRoot);
    out = out.replace(/__BASE_URL__/gi, absRoot);
    out = out.replace(/\{\{\s*BASE_URL\s*\}\}/gi, absRoot);
    // 잘못 붙은 이중 슬래시: http://host//path → http://host/path (프로토콜 뒤는 유지)
    out = out.replace(/(https?:\/\/[^/\s]+)\/{2,}/gi, '$1/');
    return out;
  };

  const toAbs = (pathname = '/') => {
    let p = String(pathname || '/').trim() || '/';
    // 플레이스홀더가 경로로 남은 경우 제거
    p = p.replace(/^\/?__SITE_URL__/i, '').replace(/^\/?\{\{?\s*SITE_URL\s*\}?\}/i, '');
    if (!p.startsWith('/')) p = `/${p}`;
    if (p === '/index.html' || p === '/index.htm') p = '/';
    if (p === '/__SITE_URL__' || p === '/__SITE_URL__/') p = '/';
    return p === '/' ? `${absRoot}/` : `${absRoot}${p}`;
  };

  const rewriteHtml = (html, fileRel) => {
    let out = replacePlaceholders(html);
    // 기존 닷홈/절대 URL 호스트 → 이번 배포 호스트
    out = out.replace(/https?:\/\/[a-z0-9._-]+\.dothome\.co\.kr/gi, absRoot);
    if (host) {
      // canonical / og:url
      out = out.replace(
        /(rel=["']canonical["']\s+href=["'])([^"']+)(["'])/gi,
        (_, a, href, c) => {
          try {
            const u = new URL(href, absRoot);
            return `${a}${toAbs(u.pathname)}${c}`;
          } catch {
            return `${a}${toAbs(href)}${c}`;
          }
        },
      );
      out = out.replace(
        /(href=["'])([^"']+)(["']\s+rel=["']canonical["'])/gi,
        (_, a, href, c) => {
          try {
            const u = new URL(href, absRoot);
            return `${a}${toAbs(u.pathname)}${c}`;
          } catch {
            return `${a}${toAbs(href)}${c}`;
          }
        },
      );
      out = out.replace(
        /(property=["']og:url["']\s+content=["'])([^"']+)(["'])/gi,
        (_, a, href, c) => {
          try {
            const u = new URL(href, absRoot);
            return `${a}${toAbs(u.pathname)}${c}`;
          } catch {
            return `${a}${toAbs(href)}${c}`;
          }
        },
      );
      out = out.replace(
        /(property=["']og:image["']\s+content=["'])([^"']+)(["'])/gi,
        (_, a, href, c) => {
          if (/^https?:\/\//i.test(href)) {
            try {
              const u = new URL(href);
              if (/\.dothome\.co\.kr$/i.test(u.host) || u.pathname.includes('__SITE_URL__')) {
                return `${a}${toAbs(u.pathname)}${c}`;
              }
            } catch { /* keep */ }
            return `${a}${href}${c}`;
          }
          return `${a}${toAbs(href)}${c}`;
        },
      );
    }
    void fileRel;
    return out;
  };

  const walkHtml = (current, rel = '') => {
    let n = 0;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return 0; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(current, ent.name);
      const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (['node_modules', '.git', '__pycache__'].includes(ent.name)) continue;
        n += walkHtml(full, nextRel);
      } else if (/\.html?$/i.test(ent.name)) {
        try {
          const raw = fs.readFileSync(full, 'utf8');
          const next = rewriteHtml(raw, nextRel);
          if (next !== raw) fs.writeFileSync(full, next, 'utf8');
          n += 1;
        } catch { /* ignore */ }
      }
    }
    return n;
  };

  const htmlFiles = walkHtml(dir);

  // sitemap.xml: 플레이스홀더 치환 후 loc 호스트 강제
  let sitemap = false;
  const smPath = path.join(dir, 'sitemap.xml');
  if (fs.existsSync(smPath)) {
    try {
      let xml = replacePlaceholders(fs.readFileSync(smPath, 'utf8'));
      xml = xml.replace(/<loc>\s*([^<\s]+)\s*<\/loc>/gi, (_, loc) => {
        const raw = String(loc || '').trim();
        if (/__SITE_URL__/i.test(raw)) {
          const rest = raw.replace(/__SITE_URL__/gi, '').replace(/^\/+/, '/') || '/';
          return `<loc>${toAbs(rest)}</loc>`;
        }
        try {
          const u = new URL(raw, absRoot);
          let pathOnly = u.pathname + (u.search || '');
          // 상대경로로 해석되어 /__SITE_URL__/ 가 된 경우
          pathOnly = pathOnly.replace(/^\/__SITE_URL__/i, '') || '/';
          return `<loc>${toAbs(pathOnly)}</loc>`;
        } catch {
          return `<loc>${toAbs(raw)}</loc>`;
        }
      });
      xml = xml.replace(/https?:\/\/[a-z0-9._-]+\.dothome\.co\.kr/gi, absRoot);
      fs.writeFileSync(smPath, xml, 'utf8');
      sitemap = true;
    } catch { /* ignore */ }
  }

  // robots.txt Sitemap 줄
  let robots = false;
  const rbPath = path.join(dir, 'robots.txt');
  try {
    let rb = fs.existsSync(rbPath)
      ? replacePlaceholders(fs.readFileSync(rbPath, 'utf8'))
      : 'User-agent: *\nAllow: /\n';
    if (/^Sitemap:\s*/im.test(rb)) {
      rb = rb.replace(/^Sitemap:\s*.*$/im, `Sitemap: ${absRoot}/sitemap.xml`);
    } else {
      rb = `${rb.replace(/\s*$/, '')}\n\nSitemap: ${absRoot}/sitemap.xml\n`;
    }
    fs.writeFileSync(rbPath, rb, 'utf8');
    robots = true;
  } catch { /* ignore */ }

  // sitemap이 전혀 없으면 로컬 HTML 기준으로 생성
  if (!sitemap) {
    try {
      const urls = [];
      const collect = (current, rel = '') => {
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (ent.name.startsWith('.')) continue;
          const full = path.join(current, ent.name);
          const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
          if (ent.isDirectory()) {
            if (['node_modules', '.git', 'img', 'images', 'assets', 'css', 'js'].includes(ent.name)) continue;
            collect(full, nextRel);
          } else if (/^index\.html?$/i.test(ent.name)) {
            urls.push(rel ? toAbs(`/${rel}/`) : `${absRoot}/`);
          } else if (/\.html?$/i.test(ent.name)) {
            urls.push(toAbs(`/${nextRel}`));
          }
        }
      };
      collect(dir);
      const uniq = [...new Set(urls.length ? urls : [`${absRoot}/`])];
      const body = uniq.map((u) => `  <url>\n    <loc>${u.replace(/\.html?$/i, '').replace(/\/index$/i, '/')}</loc>\n  </url>`).join('\n');
      fs.writeFileSync(
        smPath,
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
        'utf8',
      );
      sitemap = true;
    } catch { /* ignore */ }
  }

  log(`사이트 공개 URL 반영: ${absRoot}/ (html ${htmlFiles} · sitemap ${sitemap ? 'OK' : '-'} · robots ${robots ? 'OK' : '-'})`);
  return { htmlFiles, sitemap, robots };
}

/**
 * 성공한 ZIP을 원본 폴더 아래 `성공` 폴더로 이동.
 * 실패/미존재는 그대로 두고 { ok:false } 반환.
 * @returns {{ ok: boolean, from?: string, path?: string, skipped?: boolean, error?: string }}
 */
export function moveZipToSuccessFolder(zipPath) {
  const from = String(zipPath || '').trim();
  if (!from) return { ok: false, error: '경로 없음' };
  if (!fs.existsSync(from)) return { ok: false, from, error: '파일 없음' };

  const dir = path.dirname(from);
  const base = path.basename(from);
  if (/^성공$/i.test(path.basename(dir))) {
    return { ok: true, from, path: from, skipped: true };
  }

  const successDir = path.join(dir, '성공');
  try {
    fs.mkdirSync(successDir, { recursive: true });
  } catch (e) {
    return { ok: false, from, error: e.message || '성공 폴더 생성 실패' };
  }

  let dest = path.join(successDir, base);
  if (fs.existsSync(dest)) {
    const ext = path.extname(base);
    const stem = path.basename(base, ext);
    dest = path.join(successDir, `${stem}_${Date.now()}${ext}`);
  }

  try {
    fs.renameSync(from, dest);
    return { ok: true, from, path: dest };
  } catch (e) {
    // rename 실패(다른 드라이브 등) 시 copy+unlink
    try {
      fs.copyFileSync(from, dest);
      fs.unlinkSync(from);
      return { ok: true, from, path: dest };
    } catch (e2) {
      return { ok: false, from, error: e2.message || e.message || '이동 실패' };
    }
  }
}
