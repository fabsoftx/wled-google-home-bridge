import type { FastifyInstance } from 'fastify';
import type { WledClient, WledState } from '../wledClient.js';
import type { TokenService } from './oauth.js';
import {
  ATTRIBUTES,
  EFFECT_MODE,
  TRAITS,
  fxForSetting,
  spectrumToRgb,
  stateToGoogle,
  toWledBrightness,
} from './traits.js';

const AGENT_USER_ID = 'wled-relay-owner';

interface Command {
  command: string;
  params?: Record<string, unknown>;
}

interface SmartHomeRequest {
  requestId?: string;
  inputs?: Array<{
    intent?: string;
    payload?: {
      devices?: Array<{ id: string }>;
      commands?: Array<{ devices?: Array<{ id: string }>; execution?: Command[] }>;
    };
  }>;
}

class UnsupportedCommandError extends Error {}

function commandToPayload(cmd: Command): Record<string, unknown> {
  const p = cmd.params ?? {};
  switch (cmd.command) {
    case 'action.devices.commands.OnOff':
      return { on: Boolean(p.on) };
    case 'action.devices.commands.BrightnessAbsolute': {
      const bri = toWledBrightness(Number(p.brightness));
      return bri === 0 ? { on: false } : { on: true, bri };
    }
    case 'action.devices.commands.ColorAbsolute': {
      const spectrum = (p.color as { spectrumRGB?: number } | undefined)?.spectrumRGB;
      if (typeof spectrum !== 'number') throw new UnsupportedCommandError();
      return { on: true, seg: [{ id: 0, col: [spectrumToRgb(spectrum)] }] };
    }
    case 'action.devices.commands.SetModes': {
      const setting = (p.updateModeSettings as Record<string, string> | undefined)?.[EFFECT_MODE];
      const fx = setting ? fxForSetting(setting) : undefined;
      if (fx === undefined) throw new UnsupportedCommandError();
      return { on: true, seg: [{ id: 0, fx }] };
    }
    default:
      throw new UnsupportedCommandError();
  }
}

export function registerSmartHome(
  app: FastifyInstance,
  deps: {
    devices: Map<string, WledClient>;
    hosts: Map<string, string>;
    tokens: TokenService;
  },
): void {
  const { devices, hosts, tokens } = deps;

  const syncDevices = (): string[] => {
    const seen = new Map<string, string>();
    for (const [name, host] of hosts) {
      const current = seen.get(host);
      if (current === undefined || current === 'default') seen.set(host, name);
    }
    return [...seen.values()];
  };

  const displayName = (id: string): string =>
    `${id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} LED`;

  app.post('/smarthome', async (req, reply) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!tokens.verify(token, 'access')) {
      return reply.code(401).send({ error: 'invalid_token' });
    }

    const body = (req.body ?? {}) as SmartHomeRequest;
    const requestId = body.requestId ?? '';
    const input = body.inputs?.[0];
    req.log.info({ intent: input?.intent, requestId }, 'Smart home intent');

    switch (input?.intent) {
      case 'action.devices.SYNC':
        return {
          requestId,
          payload: {
            agentUserId: AGENT_USER_ID,
            devices: syncDevices().map((id) => ({
              id,
              type: 'action.devices.types.LIGHT',
              traits: TRAITS,
              name: {
                name: displayName(id),
                nicknames: [`${id.replace(/-/g, ' ')} lights`, id.replace(/-/g, ' ')],
                defaultNames: ['WLED Light'],
              },
              willReportState: false,
              attributes: ATTRIBUTES,
              deviceInfo: {
                manufacturer: 'BTF-Lighting / WLED',
                model: 'ESP32-WLED',
                swVersion: '16.x',
              },
            })),
          },
        };

      case 'action.devices.QUERY': {
        const ids = input.payload?.devices?.map((d) => d.id) ?? [];
        const entries = await Promise.all(
          ids.map(async (id) => {
            const client = devices.get(id);
            if (!client) {
              return [id, { online: false, status: 'ERROR', errorCode: 'deviceNotFound' }] as const;
            }
            try {
              return [id, { status: 'SUCCESS', ...stateToGoogle(await client.getState()) }] as const;
            } catch {
              return [id, { online: false, status: 'ERROR', errorCode: 'deviceOffline' }] as const;
            }
          }),
        );
        return { requestId, payload: { devices: Object.fromEntries(entries) } };
      }

      case 'action.devices.EXECUTE': {
        const results: Array<Record<string, unknown>> = [];
        for (const group of input.payload?.commands ?? []) {
          const ids = group.devices?.map((d) => d.id) ?? [];
          const groupResults = await Promise.all(
            ids.map(async (id) => {
              const client = devices.get(id);
              if (!client) return { ids: [id], status: 'ERROR', errorCode: 'deviceNotFound' };
              try {
                const payload = Object.assign(
                  {},
                  ...(group.execution ?? []).map(commandToPayload),
                ) as Record<string, unknown>;
                const state = (await client.sendState({ ...payload, v: true })) as WledState;
                return { ids: [id], status: 'SUCCESS', states: stateToGoogle(state) };
              } catch (err) {
                if (err instanceof UnsupportedCommandError) {
                  return { ids: [id], status: 'ERROR', errorCode: 'functionNotSupported' };
                }
                return { ids: [id], status: 'ERROR', errorCode: 'deviceOffline' };
              }
            }),
          );
          results.push(...groupResults);
        }
        return { requestId, payload: { commands: results } };
      }

      case 'action.devices.DISCONNECT':
        tokens.revokeAll();
        req.log.info('Google Home unlinked; all tokens revoked');
        return {};

      default:
        return { requestId, payload: { errorCode: 'protocolError' } };
    }
  });
}
