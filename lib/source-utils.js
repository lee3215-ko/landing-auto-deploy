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
