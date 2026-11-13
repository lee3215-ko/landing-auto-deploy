/**
 * susupo.app 메일함. 비밀번호는 신고 앱 설정 파일을 그대로 읽는다.
 * Electron 기본 fetch는 Set-Cookie를 숨기고 Cookie 헤더를 빼므로 node:https를 쓴다.
 */
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';

const MAILBOX_URL = 'https://my-mailbox.card50.workers.dev';
const BUNDLED_MAILBOX_PASSWORD = "zhfldk123!";
const CODE_LABELED = /인증번호\s*[:：]\s*(\d{6})/;

function mailboxSettingFiles() {
  const home = os.homedir();
  return [
    'E:\\뉴 네이버신고플\\data\\settings.json',
    'C:\\뉴 네이버신고플\\data\\settings.json',
    path.join(home, '뉴 네이버신고플', 'data', 'settings.json'),
    path.join(home, 'Desktop', '뉴 네이버신고플', 'data', 'settings.json'),
    path.join(home, 'OneDrive', 'Desktop', '뉴 네이버신고플', 'data', 'settings.json'),
    path.join(home, 'OneDrive', '바탕 화면', '뉴 네이버신고플', 'data', 'settings.json'),
  ];
}

function loadMailboxPassword() {
  for (const file of mailboxSettingFiles()) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const pw = String(raw?.mailbox_password || '').trim();
      if (pw) return pw;
    } catch { /* 다음 위치 */ }
  }
  return String(BUNDLED_MAILBOX_PASSWORD || '').trim();
}

function extractCode(text) {
  const match = String(text || '').match(CODE_LABELED);
  return match ? match[1] : '';
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

function receivedMs(item) {
  const n = Number(item?.received_at) || 0;
  if (!n) return 0;
  return n < 1e12 ? n * 1000 : n;
}

export class SusupoMailbox {
  constructor() {
    this.base = MAILBOX_URL;
    this.password = loadMailboxPassword();
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  storeCookies(headers) {
    const raw = headers?.['set-cookie'];
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    for (const line of list) {
      const pair = String(line || '').split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async login() {
    if (!this.password) {
      throw new Error('메일함 비밀번호를 읽지 못했습니다.');
    }
    await this.request('POST', '/api/login', { password: this.password });
    if (!this.cookies.size) {
      throw new Error('메일함 로그인 쿠키를 받지 못했습니다.');
    }
  }

  async waitForCode(recipient, sinceMs, timeoutMs = 90000, log = () => {}) {
    if (!this.cookies.size) await this.login();
    const local = String(recipient || '').split('@')[0].trim();
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    while (Date.now() < deadline) {
      const code = await this.findCode(local, recipient, sinceMs, log, !announced);
      if (code) {
        log('인증 메일을 찾았습니다.');
        return code;
      }
      if (!announced) {
        log('인증 메일을 기다리는 중');
        announced = true;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return '';
  }

  async findCode(local, recipient, sinceMs, log = () => {}, report = false) {
    const messages = await this.messagesFor(local);
    messages.sort((a, b) => {
      const aAuth = /인증번호/.test(a?.subject || '') ? 1 : 0;
      const bAuth = /인증번호/.test(b?.subject || '') ? 1 : 0;
      if (aAuth !== bAuth) return bAuth - aAuth;
      return receivedMs(b) - receivedMs(a);
    });
    if (report) {
      log(messages.length
        ? `메일함에서 ${messages.length}통을 확인합니다.`
        : '이 주소로 온 메일이 아직 없습니다.');
    }
    const wanted = String(recipient || '').toLowerCase();
    const needle = local.toLowerCase();
    for (const item of messages) {
      const received = receivedMs(item);
      if (received && received < sinceMs) continue;
      const toAddr = String(item?.recipient || item?.local_part || '').toLowerCase();
      if (toAddr && !toAddr.includes(wanted) && !toAddr.includes(needle)) continue;
      let text = `${item?.subject || ''}\n${item?.snippet || ''}`;
      const body = await this.readBody(item.id);
      if (body) text = `${text}\n${body}`;
      const code = extractCode(text);
      if (code) return code;
    }
    return '';
  }

  async messagesFor(local) {
    const direct = await this.request('GET', '/api/messages', null, { address: local });
    const list = Array.isArray(direct?.messages) ? direct.messages : [];
    if (list.length) return list;
    const recent = await this.request('GET', '/api/messages');
    const needle = local.toLowerCase();
    return (recent?.messages || []).filter((item) => {
      const blob = `${item?.recipient || ''} ${item?.local_part || ''} ${item?.subject || ''}`.toLowerCase();
      return blob.includes(needle);
    });
  }

  async readBody(messageId) {
    try {
      const payload = await this.request('GET', `/api/messages/${messageId}`);
      const message = payload?.message || {};
      let text = String(message.text_body || '');
      if (message.has_html) {
        try {
          const html = await this.requestText('GET', `/api/messages/${messageId}/html`);
          text = `${text}\n${stripHtml(html)}`;
        } catch { /* 본문에 번호가 있으면 HTML 실패는 무시 */ }
      }
      return text;
    } catch {
      return '';
    }
  }

  async request(method, path, body, query) {
    const raw = await this.requestText(method, path, body, query);
    if (!raw) return {};
    try {
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    } catch {
      throw new Error('메일함 응답을 읽지 못했습니다.');
    }
  }

  async requestText(method, path, body, query, retried = false) {
    const url = new URL(this.base + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value) url.searchParams.set(key, value);
      }
    }
    const headers = { Accept: 'application/json', 'User-Agent': 'landing-auto-deploy' };
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body != null) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const res = await this.httpsRequest(method, url, headers, payload);
    this.storeCookies(res.headers);
    if (res.status === 401 && path !== '/api/login' && !retried) {
      this.cookies.clear();
      await this.login();
      return this.requestText(method, path, body, query, true);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`메일함 오류 (${res.status})`);
    }
    return res.text;
  }

  httpsRequest(method, url, headers, payload) {
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', (err) => reject(new Error(`메일함에 연결하지 못했습니다. ${err.message}`)));
      req.setTimeout(15000, () => req.destroy(new Error('메일함 시간 초과')));
      if (payload) req.write(payload);
      req.end();
    });
  }
}
