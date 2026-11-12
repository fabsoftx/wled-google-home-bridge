import 'dotenv/config';
import { z } from 'zod';

const normalizeHost = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
};

function emptyToUndefined(v: string | undefined): string | undefined {
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3080),
  WLED_HOST: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? normalizeHost(v) : undefined)),
  WLED_DEVICES: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v : undefined)),
  API_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  ALLOW_LOCAL_UNAUTHENTICATED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  TRUST_CLOUDFLARE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  GOOGLE_CLIENT_ID: z.string().optional().transform(emptyToUndefined),
  GOOGLE_CLIENT_SECRET: z.string().optional().transform(emptyToUndefined),
  GOOGLE_PROJECT_ID: z.string().optional().transform(emptyToUndefined),
  ADMIN_PASSWORD: z.string().optional().transform(emptyToUndefined),
  TOKEN_SIGNING_SECRET: z.string().optional().transform(emptyToUndefined),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const DEVICE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESERVED_DEVICE_NAMES = new Set([
  'status',
  'power',
  'toggle',
  'brightness',
  'preset',
  'color',
  'effect',
  'raw',
  'devices',
]);

function parseDeviceMap(env: {
  WLED_DEVICES?: string;
  WLED_HOST?: string;
}): Map<string, string> {
  const devices = new Map<string, string>();
  const errors: string[] = [];

  if (env.WLED_DEVICES) {
    for (const entry of env.WLED_DEVICES.split(',')) {
      const eq = entry.indexOf('=');
      if (eq === -1) {
        errors.push(`  "${entry.trim()}" — expected format name=host`);
        continue;
      }
      const name = entry.slice(0, eq).trim().toLowerCase();
      const host = entry.slice(eq + 1).trim();
      if (!DEVICE_NAME_RE.test(name)) {
        errors.push(`  invalid device name "${name}" (use a-z, 0-9, -)`);
      } else if (RESERVED_DEVICE_NAMES.has(name)) {
        errors.push(`  "${name}" is a reserved name`);
      } else if (!host) {
        errors.push(`  "${name}" is missing a host`);
      } else if (devices.has(name)) {
        errors.push(`  duplicate device "${name}"`);
      } else {
        devices.set(name, normalizeHost(host));
      }
    }
  }

  if (env.WLED_HOST && !devices.has('default')) {
    devices.set('default', env.WLED_HOST);
  }
  if (devices.size === 0) {
    errors.push('  set WLED_HOST or WLED_DEVICES');
  }
  if (errors.length > 0) {
    throw new Error(`Invalid device configuration:\n${errors.join('\n')}`);
  }
  return devices;
}

const devices = ((): Map<string, string> => {
  try {
    return parseDeviceMap(parsed.data);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
})();

const defaultDevice = devices.has('default')
  ? 'default'
  : (devices.keys().next().value as string);

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  projectId?: string;
  adminPassword: string;
  signingSecret: string;
  trustCloudflare: boolean;
}

const google = ((): GoogleConfig | undefined => {
  const e = parsed.data;
  const required = {
    GOOGLE_CLIENT_ID: e.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: e.GOOGLE_CLIENT_SECRET,
    ADMIN_PASSWORD: e.ADMIN_PASSWORD,
    TOKEN_SIGNING_SECRET: e.TOKEN_SIGNING_SECRET,
  };
  const set = Object.entries(required).filter(([, v]) => v !== undefined);
  if (set.length === 0) return undefined;

  const errors: string[] = [];
  if (set.length !== Object.keys(required).length) {
    const missing = Object.entries(required)
      .filter(([, v]) => v === undefined)
      .map(([k]) => k);
    errors.push(`  Google integration is partially configured; missing: ${missing.join(', ')}`);
  }
  if (e.GOOGLE_CLIENT_SECRET && e.GOOGLE_CLIENT_SECRET.length < 24) {
    errors.push('  GOOGLE_CLIENT_SECRET must be at least 24 characters');
  }
  if (e.ADMIN_PASSWORD && e.ADMIN_PASSWORD.length < 12) {
    errors.push('  ADMIN_PASSWORD must be at least 12 characters');
  }
  if (e.TOKEN_SIGNING_SECRET && e.TOKEN_SIGNING_SECRET.length < 32) {
    errors.push('  TOKEN_SIGNING_SECRET must be at least 32 characters');
  }
  if (errors.length > 0) {
    console.error(`Invalid Google configuration:\n${errors.join('\n')}`);
    process.exit(1);
  }
  return {
    clientId: e.GOOGLE_CLIENT_ID as string,
    clientSecret: e.GOOGLE_CLIENT_SECRET as string,
    projectId: e.GOOGLE_PROJECT_ID,
    adminPassword: e.ADMIN_PASSWORD as string,
    signingSecret: e.TOKEN_SIGNING_SECRET as string,
    trustCloudflare: e.TRUST_CLOUDFLARE,
  };
})();

export const config = { ...parsed.data, devices, defaultDevice, google };
export type AppConfig = typeof config;
