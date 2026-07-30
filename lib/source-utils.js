import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { extractZip } from './deploy.js';

export function extractTitleFromHtml(html) {
  if (!html) return '';
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return m[1]
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findIndexHtmlRelative(dir) {
  if (fs.existsSync(path.join(dir, 'index.html'))) return 'index.html';

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sub = path.join(ent.name, 'index.html');
    if (fs.existsSync(path.join(dir, sub))) return sub;
  }

  const files = entries.filter(e => e.isFile()).map(e => e.name);
  const fallback = files.find(f => /^index_[^\\/]+\.html$/i.test(f));
  if (fallback) return fallback;

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const subDir = path.join(dir, ent.name);
    const subFiles = fs.readdirSync(subDir).filter(f => fs.statSync(path.join(subDir, f)).isFile());
    const subFallback = subFiles.find(f => /^index_[^\\/]+\.html$/i.test(f));
    if (subFallback) return path.join(ent.name, subFallback);
  }

  return null;
}

/** ZIP 압축 해제 후 index.html이 있는 실제 사이트 루트 폴더 반환 */
export async function resolveZipSiteDir(zipPath, extractTo) {
  await extractZip(zipPath, extractTo);
  const rel = findIndexHtmlRelative(extractTo);
  if (!rel) {
    throw new Error('ZIP 파일에서 index.html을 찾을 수 없습니다. (루트 또는 하위 폴더 1단계에 index.html 필요)');
  }
  const htmlDir = path.dirname(rel) === '.'
    ? extractTo
    : path.join(extractTo, path.dirname(rel));
  return { htmlDir, indexRel: rel };
}

async function findIndexHtmlInZip(zip) {
  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  let rel = names.find(n => /(^|\/)index\.html$/i.test(n));
  if (!rel) rel = names.find(n => /(^|\/)index_[^/]+\.html$/i.test(n));
  return rel || null;
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
