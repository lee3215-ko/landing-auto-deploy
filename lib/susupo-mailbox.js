/**
 * susupo.app 메일함. 비밀번호는 신고 앱 설정 파일을 그대로 읽는다.
 */
import fs from 'fs';

const MAILBOX_URL = 'https://my-mailbox.card50.workers.dev';
const SETTINGS_FILE = 'E:\\뉴 네이버신고플\\data\\settings.json';
const CODE_NEAR = /인증[^\d]{0,24}(\d{4,8})/;
const CODE_ANY = /(?<!\d)(\d{4,8})(?!\d)/g;

function loadMailboxPassword() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return String(raw?.mailbox_password || '').trim();
  } catch {
    return '';
  }
}

function extractCode(text) {
  const blob = String(text || '');
  const near = blob.match(CODE_NEAR);
  if (near) return near[1];
  for (const match of blob.matchAll(CODE_ANY)) {
    const token = match[1];
    if (token.startsWith('1588') || token.startsWith('1599')) continue;
    return token;
  }
  return '';
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

export class SusupoMailbox {
  constructor() {
    this.base = MAILBOX_URL;
    this.password = loadMailboxPassword();
    this.cookie = '';
  }

  async login() {
    if (!this.password) {
      throw new Error('메일함 비밀번호를 읽지 못했습니다.');
    }
    await this.request('POST', '/api/login', { password: this.password });
  }

  async waitForCode(recipient, sinceMs, timeoutMs = 90000, log = () => {}) {
    if (!this.cookie) await this.login();
    const local = String(recipient || '').split('@')[0].trim();
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    while (Date.now() < deadline) {
      const code = await this.findCode(local, recipient, sinceMs);
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

  async findCode(local, recipient, sinceMs) {
    const messages = await this.messagesFor(local);
    const wanted = String(recipient || '').toLowerCase();
    for (const item of messages) {
      const received = Number(item?.received_at) || 0;
      if (received && received < sinceMs) continue;
      const toAddr = String(item?.recipient || '').toLowerCase();
      if (toAddr && !toAddr.includes(wanted) && !toAddr.includes(local.toLowerCase())) continue;
      let text = `${item?.subject || ''}\n${item?.snippet || ''}`;
      try {
        const body = await this.readBody(item.id);
        text = `${text}\n${body}`;
      } catch { /* snippet만 사용 */ }
      const code = extractCode(text);
      if (code) return code;
    }
    return '';
  }

  async messagesFor(local) {
    const direct = await this.request('GET', '/api/messages', null, { address: local });
    const list = Array.isArray(direct?.messages) ? direct.messages : [];
    if (list.length) return list;
    const searched = await this.request('GET', '/api/messages', null, { q: local });
    const needle = local.toLowerCase();
    return (searched?.messages || []).filter((item) => {
      const blob = `${item?.recipient || ''} ${item?.subject || ''}`.toLowerCase();
      return blob.includes(needle);
    });
  }

  async readBody(messageId) {
    const payload = await this.request('GET', `/api/messages/${messageId}`);
    const message = payload?.message || {};
    let text = String(message.text_body || '');
    if (message.has_html) {
      const html = await this.requestText('GET', `/api/messages/${messageId}/html`);
      text = `${text}\n${stripHtml(html)}`;
    }
    return text;
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
    if (this.cookie) headers.Cookie = this.cookie;
    let payload;
    if (body != null) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, { method, headers, body: payload });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      if (pair) this.cookie = pair;
    }
    const text = await res.text();
    if (res.status === 401 && path !== '/api/login' && !retried) {
      this.cookie = '';
      await this.login();
      return this.requestText(method, path, body, query, true);
    }
    if (!res.ok) {
      throw new Error(`메일함 오류 (${res.status})`);
    }
    return text;
  }
}
