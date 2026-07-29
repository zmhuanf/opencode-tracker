import type { PricingMap, PricingSaveReq, Summary, UsageFilter, UsageResponse } from '@/types';

type FengCocos = {
  Client: new (config?: any) => any;
  ClientMode: { Client: 0; Server: 1 };
  Config: new () => any;
  JsonCodec: new () => any;
  ConsoleLogger: new () => any;
};

const lib: FengCocos = (globalThis as any)['feng-cocos'];
if (!lib) throw new Error('feng-cocos umd 未加载');

// ClientMode.Client 才会同时连 system + user 通道，server.Handle 注册的业务路由都在 user 通道。
// ClientMode.Server 只连 system，业务请求会被 "route not found" 拒掉。
let clientPromise: Promise<InstanceType<typeof lib.Client>> | null = null;

function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const config = new lib.Config();
      config.addr = window.location.hostname;
      config.port = Number(new URLSearchParams(location.search).get('port')) || 8080;
      config.mode = lib.ClientMode.Client;
      config.directConnect = true;
      config.codec = new lib.JsonCodec();
      config.logger = new lib.ConsoleLogger();
      const c = new lib.Client(config);
      await c.connect();
      return c;
    })();
  }
  return clientPromise;
}

async function call<T>(route: string, payload: unknown): Promise<T> {
  const c = await getClient();
  const [, data] = await c.request(route, payload);
  return data as T;
}

export const api = {
  usage: (q: UsageFilter & { page: number; pageSize: number }) => call<UsageResponse>('/api/usage', q),
  summary: (q: UsageFilter) => call<Summary>('/api/usage/summary', q),
  providers: () => call<string[]>('/api/providers', ''),
  models: () => call<string[]>('/api/models', ''),
  pricing: () => call<PricingMap>('/api/pricing', ''),
  savePricing: (req: PricingSaveReq) => call<PricingMap>('/api/pricing/save', req),
};
