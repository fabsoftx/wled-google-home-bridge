export interface ConnectivityStatus {
  reachable: boolean | null;
  lastChecked: string | null;
  lastError: string | null;
}

export interface WledInfo {
  name?: string;
  ver?: string;
  mac?: string;
  uptime?: number;
  leds?: { count?: number; pwr?: number; maxpwr?: number };
  wifi?: { rssi?: number; signal?: number; bssid?: string; channel?: number };
  [key: string]: unknown;
}

export interface WledState {
  on?: boolean;
  bri?: number;
  ps?: number;
  pl?: number;
  seg?: unknown[];
  [key: string]: unknown;
}

export class WledUnreachableError extends Error {
  readonly code = 'TARGET_UNREACHABLE';
  constructor(host: string, cause?: unknown) {
    super(`ESP32 at ${host} failed to respond`);
    this.name = 'WledUnreachableError';
    this.cause = cause;
  }
}

export class WledApiError extends Error {
  readonly code = 'TARGET_ERROR';
  constructor(host: string, readonly status: number) {
    super(`ESP32 at ${host} returned HTTP ${status}`);
    this.name = 'WledApiError';
  }
}

export class WledClient {
  private connectivity: ConnectivityStatus = {
    reachable: null,
    lastChecked: null,
    lastError: null,
  };

  constructor(
    private readonly host: string,
    private readonly timeoutMs: number,
  ) {}

  private mark(ok: boolean, err: unknown): void {
    this.connectivity = {
      reachable: ok,
      lastChecked: new Date().toISOString(),
      lastError: ok ? null : err instanceof Error ? err.message : String(err),
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.host}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.mark(false, err);
      throw new WledUnreachableError(this.host, err);
    }

    if (!res.ok) {
      this.mark(false, new WledApiError(this.host, res.status));
      throw new WledApiError(this.host, res.status);
    }

    try {
      const body = (await res.json()) as T;
      this.mark(true, null);
      return body;
    } catch (err) {
      this.mark(false, err);
      throw new WledUnreachableError(this.host, err);
    }
  }

  getInfo(): Promise<WledInfo> {
    return this.request<WledInfo>('/json/info');
  }

  getState(): Promise<WledState> {
    return this.request<WledState>('/json/state');
  }

  sendState(payload: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('/json/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  getConnectivity(): ConnectivityStatus {
    return { ...this.connectivity };
  }
}
