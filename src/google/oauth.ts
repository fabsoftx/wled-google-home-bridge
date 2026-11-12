import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GoogleConfig } from '../config.js';

const ACCESS_TTL_SECONDS = 86_400;
const CODE_TTL_MS = 5 * 60_000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;
const GOOGLE_REDIRECT_HOSTS = new Set([
  'oauth-redirect.googleusercontent.com',
  'oauth-redirect-sandbox.googleusercontent.com',
]);

type TokenType = 'access' | 'refresh';
interface TokenPayload {
  typ: TokenType;
  iat: number;
  exp?: number;
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64url');

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export class TokenService {
  private revokedBefore = 0;

  constructor(private readonly secret: string) {}

  private sign(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }

  issue(typ: TokenType): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: TokenPayload = {
      typ,
      iat: now,
      ...(typ === 'access' ? { exp: now + ACCESS_TTL_SECONDS } : {}),
    };
    const body = b64url(JSON.stringify(payload));
    return `${body}.${this.sign(body)}`;
  }

  verify(token: string | undefined, typ: TokenType): boolean {
    if (!token) return false;
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra !== undefined) return false;
    if (!safeEqual(sig, this.sign(body))) return false;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
      const now = Math.floor(Date.now() / 1000);
      return (
        p.typ === typ &&
        p.iat >= this.revokedBefore &&
        (p.exp === undefined || p.exp > now)
      );
    } catch {
      return false;
    }
  }

  revokeAll(): void {
    this.revokedBefore = Math.floor(Date.now() / 1000) + 1;
  }
}

class FailureLimiter {
  private failures = new Map<string, { count: number; resetAt: number }>();

  blocked(key: string): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  }

  fail(key: string): void {
    const now = Date.now();
    const entry = this.failures.get(key);
    if (!entry || now > entry.resetAt) {
      this.failures.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
    } else {
      entry.count += 1;
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

function securePage(reply: FastifyReply): FastifyReply {
  return reply
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('x-frame-options', 'DENY')
    .header('referrer-policy', 'no-referrer')
    .header(
      'content-security-policy',
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${[...GOOGLE_REDIRECT_HOSTS].map((h) => `https://${h}`).join(' ')}; frame-ancestors 'none'`,
    );
}

function renderPage(fields: Record<string, string>, error?: string): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link WLED Relay</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;font-family:system-ui,sans-serif;color:#e6e6e6}
  .card{background:#181b22;padding:32px;border-radius:14px;width:min(360px,90vw);box-shadow:0 8px 30px #0006}
  h1{font-size:20px;margin:0 0 6px}
  p{margin:0 0 20px;color:#9aa0aa;font-size:14px}
  input[type=password]{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #2c313c;background:#0f1115;color:inherit;font-size:15px}
  button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:8px;background:#4285f4;color:#fff;font-size:15px;cursor:pointer}
  .err{color:#ff6b6b;font-size:14px;margin:0 0 12px}
</style></head>
<body><form class="card" method="post" action="/oauth/authorize">
  <h1>Link WLED Relay</h1>
  <p>Allow Google Home to control your WLED lights.</p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  ${hidden}
  <input type="password" name="password" placeholder="Admin password" autocomplete="current-password" required autofocus>
  <button type="submit">Authorize Google Home</button>
</form></body></html>`;
}

function errorPage(reply: FastifyReply, status: number, message: string) {
  return securePage(reply)
    .code(status)
    .send(
      `<!doctype html><meta charset="utf-8"><title>Error</title><body style="font-family:system-ui;padding:40px">${escapeHtml(message)}</body>`,
    );
}

export function registerOAuth(
  app: FastifyInstance,
  google: GoogleConfig,
  tokens: TokenService,
): void {
  const codes = new Map<string, { redirectUri: string; expiresAt: number }>();
  const limiter = new FailureLimiter();

  const clientKey = (req: FastifyRequest): string => {
    if (google.trustCloudflare) {
      const cf = req.headers['cf-connecting-ip'];
      if (typeof cf === 'string' && cf.length > 0) return cf;
    }
    return req.ip;
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of codes) {
      if (entry.expiresAt < now) codes.delete(code);
    }
  }, 60_000);
  sweep.unref();

  const validRedirect = (raw: string | undefined): boolean => {
    if (!raw) return false;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || !GOOGLE_REDIRECT_HOSTS.has(url.hostname)) {
        return false;
      }
      return google.projectId
        ? url.pathname === `/r/${google.projectId}`
        : url.pathname.startsWith('/r/');
    } catch {
      return false;
    }
  };

  const validateAuthRequest = (q: Record<string, string | undefined>): string | null => {
    if (q.response_type !== 'code') return 'Unsupported response_type';
    if (!q.client_id || !safeEqual(q.client_id, google.clientId)) return 'Unknown client';
    if (!validRedirect(q.redirect_uri)) return 'Invalid redirect_uri';
    if (!q.state) return 'Missing state';
    return null;
  };

  const fieldsFrom = (q: Record<string, string | undefined>) => ({
    client_id: q.client_id ?? '',
    redirect_uri: q.redirect_uri ?? '',
    state: q.state ?? '',
    response_type: q.response_type ?? '',
  });

  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const problem = validateAuthRequest(q);
    if (problem) return errorPage(reply, 400, problem);
    return securePage(reply).send(renderPage(fieldsFrom(q)));
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const problem = validateAuthRequest(body);
    if (problem) return errorPage(reply, 400, problem);

    const key = clientKey(req);
    if (limiter.blocked(key)) {
      return securePage(reply)
        .code(429)
        .send(renderPage(fieldsFrom(body), 'Too many attempts. Try again in 15 minutes.'));
    }
    if (!body.password || !safeEqual(body.password, google.adminPassword)) {
      limiter.fail(key);
      req.log.warn({ ip: key }, 'OAuth login failed');
      return securePage(reply)
        .code(401)
        .send(renderPage(fieldsFrom(body), 'Incorrect password.'));
    }
    limiter.reset(key);

    const code = randomBytes(32).toString('base64url');
    codes.set(code, {
      redirectUri: body.redirect_uri as string,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const target = new URL(body.redirect_uri as string);
    target.searchParams.set('code', code);
    target.searchParams.set('state', body.state as string);
    req.log.info('OAuth authorization code issued');
    return reply.header('cache-control', 'no-store').redirect(target.toString(), 302);
  });

  app.post('/oauth/token', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    let clientId = body.client_id;
    let clientSecret = body.client_secret;

    const auth = req.headers.authorization;
    if (auth?.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString();
      const sep = decoded.indexOf(':');
      if (sep !== -1) {
        clientId = decodeURIComponent(decoded.slice(0, sep));
        clientSecret = decodeURIComponent(decoded.slice(sep + 1));
      }
    }

    reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
    const fail = (status: number, error: string) => reply.code(status).send({ error });

    const key = clientKey(req);
    if (limiter.blocked(key)) return fail(429, 'slow_down');
    if (
      !clientId ||
      !clientSecret ||
      !safeEqual(clientId, google.clientId) ||
      !safeEqual(clientSecret, google.clientSecret)
    ) {
      limiter.fail(key);
      return fail(401, 'invalid_client');
    }

    if (body.grant_type === 'authorization_code') {
      const entry = body.code ? codes.get(body.code) : undefined;
      if (body.code) codes.delete(body.code);
      if (!entry || entry.expiresAt < Date.now() || entry.redirectUri !== body.redirect_uri) {
        return fail(400, 'invalid_grant');
      }
      req.log.info('OAuth tokens issued (authorization_code)');
      return {
        token_type: 'Bearer',
        access_token: tokens.issue('access'),
        refresh_token: tokens.issue('refresh'),
        expires_in: ACCESS_TTL_SECONDS,
      };
    }

    if (body.grant_type === 'refresh_token') {
      if (!tokens.verify(body.refresh_token, 'refresh')) return fail(400, 'invalid_grant');
      return {
        token_type: 'Bearer',
        access_token: tokens.issue('access'),
        expires_in: ACCESS_TTL_SECONDS,
      };
    }

    return fail(400, 'unsupported_grant_type');
  });
}
