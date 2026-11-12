import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, type ZodError, type ZodType } from 'zod';
import type { AppConfig } from './config.js';
import type { WledClient } from './wledClient.js';

export class ValidationError extends Error {
  readonly statusCode = 400;
  constructor(public readonly issues: ZodError['issues']) {
    super('Invalid request payload');
    this.name = 'ValidationError';
  }
}

export class UnknownDeviceError extends Error {
  readonly statusCode = 404;
  constructor(device: string) {
    super(`No WLED device named "${device}" is configured`);
    this.name = 'UnknownDeviceError';
  }
}

function parse<S extends ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new ValidationError(result.error.issues);
  return result.data;
}

const byte = z.number().int().min(0).max(255);
const segmentId = z.number().int().min(0).max(31);

const powerSchema = z.object({
  on: z.union([z.boolean(), z.literal('toggle')]),
});

const brightnessSchema = z
  .object({
    value: z.number().int().min(-255).max(255),
    relative: z.boolean().optional().default(false),
  })
  .refine((d) => d.relative || (d.value >= 0 && d.value <= 255), {
    path: ['value'],
    message: 'value must be between 0 and 255 unless relative is true',
  });

const presetParamsSchema = z.object({
  id: z.coerce.number().int().min(1).max(250),
});

const colorSchema = z
  .object({
    hex: z
      .string()
      .regex(/^#?[0-9a-fA-F]{6}$/, 'hex must be a 6-digit color, e.g. "#FF8800"')
      .optional(),
    rgb: z.tuple([byte, byte, byte]).optional(),
    segment: segmentId.optional().default(0),
  })
  .refine((d) => d.hex !== undefined || d.rgb !== undefined, {
    message: 'provide either "hex" or "rgb"',
  });

const effectSchema = z.object({
  effectId: z.number().int().min(0).max(255),
  speed: byte.optional(),
  intensity: byte.optional(),
  paletteId: z.number().int().min(0).max(255).optional(),
  segment: segmentId.optional().default(0),
});

const rawSchema = z.record(z.string(), z.unknown());

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HEALTH_PROBE_INTERVAL_MS = 10_000;

function tokenEquals(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerRoutes(
  app: FastifyInstance,
  deps: {
    devices: Map<string, WledClient>;
    defaultDevice: string;
    config: AppConfig;
  },
): void {
  const { devices, defaultDevice, config } = deps;
  let lastHealthProbeAt = 0;

  const clientFor = (req: FastifyRequest): WledClient => {
    const { device } = req.params as { device?: string };
    const client = devices.get(device ?? defaultDevice);
    if (!client) throw new UnknownDeviceError(device ?? '');
    return client;
  };

  app.get('/health', async () => {
    const now = Date.now();
    const defaultClient = devices.get(defaultDevice);
    if (defaultClient && now - lastHealthProbeAt >= HEALTH_PROBE_INTERVAL_MS) {
      lastHealthProbeAt = now;
      await defaultClient.getInfo().catch(() => undefined);
    }
    const connectivity = defaultClient?.getConnectivity() ?? null;
    return {
      success: true,
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      wled: connectivity
        ? { reachable: connectivity.reachable, lastChecked: connectivity.lastChecked }
        : null,
    };
  });

  app.register(
    async (api) => {
      api.addHook('onRequest', async (req, reply) => {
        if (!config.API_AUTH_TOKEN) return;

        const viaTunnel =
          'cf-ray' in req.headers || 'cf-connecting-ip' in req.headers;
        if (
          config.ALLOW_LOCAL_UNAUTHENTICATED &&
          LOOPBACK_IPS.has(req.ip) &&
          !viaTunnel
        ) {
          return;
        }

        const headerToken = req.headers['x-relay-token'];
        const authorization = req.headers.authorization;
        const bearer = authorization?.startsWith('Bearer ')
          ? authorization.slice(7)
          : undefined;
        const supplied =
          (typeof headerToken === 'string' ? headerToken : undefined) ?? bearer;

        if (!supplied || !tokenEquals(supplied, config.API_AUTH_TOKEN)) {
          return reply.code(401).send({
            success: false,
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid relay token',
          });
        }
      });

      const route = (
        method: 'GET' | 'POST' | Array<'GET' | 'POST'>,
        p: string,
        handler: (
          req: FastifyRequest,
        ) => Promise<{ success: true; data: unknown }>,
      ): void => {
        for (const url of [`/wled${p}`, `/wled/:device${p}`]) {
          api.route({ method, url, handler });
        }
      };

      api.get('/devices', async () => {
        await Promise.all(
          [...devices.values()].map((c) => c.getInfo().catch(() => undefined)),
        );
        return {
          success: true,
          data: {
            default: defaultDevice,
            devices: [...devices.entries()].map(([name, client]) => ({
              name,
              host: config.devices.get(name),
              connectivity: client.getConnectivity(),
            })),
          },
        };
      });

      route('GET', '/status', async (req) => {
        const client = clientFor(req);
        const [info, state] = await Promise.all([
          client.getInfo(),
          client.getState(),
        ]);
        return {
          success: true,
          data: {
            on: state.on ?? null,
            brightness: state.bri ?? null,
            preset: state.ps ?? null,
            leds: info.leds?.count ?? null,
            wifiRssi: info.wifi?.rssi ?? null,
            name: info.name ?? null,
            version: info.ver ?? null,
            mac: info.mac ?? null,
          },
        };
      });

      route('POST', '/power', async (req) => {
        const body = parse(powerSchema, req.body);
        const payload = body.on === 'toggle' ? { on: 't' } : { on: body.on };
        const data = await clientFor(req).sendState(payload);
        return { success: true, data };
      });

      route('GET', '/toggle', async (req) => {
        const data = await clientFor(req).sendState({ on: 't' });
        return { success: true, data };
      });

      route('POST', '/brightness', async (req) => {
        const body = parse(brightnessSchema, req.body);
        const payload = body.relative
          ? { bri: body.value >= 0 ? `+${body.value}` : `${body.value}` }
          : { bri: body.value };
        const data = await clientFor(req).sendState(payload);
        return { success: true, data };
      });

      route(['GET', 'POST'], '/preset/:id', async (req) => {
        const { id } = parse(presetParamsSchema, req.params);
        const data = await clientFor(req).sendState({ ps: id });
        return { success: true, data };
      });

      route('POST', '/color', async (req) => {
        const body = parse(colorSchema, req.body);
        const rgb = body.rgb ?? hexToRgb(body.hex as string);
        const data = await clientFor(req).sendState({
          seg: [{ id: body.segment, col: [rgb] }],
        });
        return { success: true, data };
      });

      route('POST', '/effect', async (req) => {
        const body = parse(effectSchema, req.body);
        const data = await clientFor(req).sendState({
          seg: [
            {
              id: body.segment,
              fx: body.effectId,
              sx: body.speed,
              ix: body.intensity,
              pal: body.paletteId,
            },
          ],
        });
        return { success: true, data };
      });

      route('POST', '/raw', async (req) => {
        const payload = parse(rawSchema, req.body);
        const data = await clientFor(req).sendState(payload);
        return { success: true, data };
      });
    },
    { prefix: '/api/v1' },
  );
}
