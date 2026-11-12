import Fastify from 'fastify';
import { config } from './config.js';
import { registerOAuth, TokenService } from './google/oauth.js';
import { registerSmartHome } from './google/smartHome.js';
import {
  registerRoutes,
  UnknownDeviceError,
  ValidationError,
} from './routes.js';
import {
  WledApiError,
  WledClient,
  WledUnreachableError,
} from './wledClient.js';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      config.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } }
        : undefined,
  },
});

const devices = new Map<string, WledClient>(
  [...config.devices.entries()].map(([name, host]) => [
    name,
    new WledClient(host, config.TIMEOUT_MS),
  ]),
);

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ValidationError) {
    return reply.code(400).send({
      success: false,
      code: 'VALIDATION_ERROR',
      message: err.message,
      issues: err.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      })),
    });
  }
  if (err instanceof UnknownDeviceError) {
    return reply.code(404).send({
      success: false,
      code: 'UNKNOWN_DEVICE',
      message: err.message,
    });
  }
  if (err instanceof WledUnreachableError) {
    return reply.code(502).send({
      success: false,
      code: 'TARGET_UNREACHABLE',
      message: err.message,
    });
  }
  if (err instanceof WledApiError) {
    return reply.code(502).send({
      success: false,
      code: 'TARGET_ERROR',
      message: err.message,
    });
  }
  if ((err as { statusCode?: number }).statusCode === 400) {
    return reply.code(400).send({
      success: false,
      code: 'BAD_REQUEST',
      message: 'Malformed request',
    });
  }
  req.log.error(err);
  return reply.code(500).send({
    success: false,
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
  });
});

app.setNotFoundHandler((req, reply) =>
  reply.code(404).send({
    success: false,
    code: 'NOT_FOUND',
    message: `${req.method} ${req.url} not found`,
  }),
);

registerRoutes(app, { devices, defaultDevice: config.defaultDevice, config });

if (config.google) {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );
  const tokens = new TokenService(config.google.signingSecret);
  registerOAuth(app, config.google, tokens);
  registerSmartHome(app, { devices, hosts: config.devices, tokens });
}

process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'Uncaught exception');
});

const shutdown = (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  void app.close().then(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(
    {
      devices: Object.fromEntries(config.devices),
      default: config.defaultDevice,
      port: config.PORT,
      googleSmartHome: config.google ? 'enabled' : 'disabled',
    },
    'WLED relay listening',
  );
} catch (err) {
  app.log.fatal({ err }, 'Failed to start server');
  process.exit(1);
}
