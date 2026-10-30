import { join } from "node:path";

export interface AppConfig {
  port: number;
  host: string;
  apiKey?: string | undefined;
  pigatewayUrl: string;
  picamUrl: string;
  pilightUrl: string;
  piprogramUrl: string;
  piembedUrl: string;
  autoConnectGateway: boolean;
  defaultRundownPath?: string | undefined;
  storageDir: string;
}

export function loadConfig(env = process.env): AppConfig {
  return {
    port: parseInt(env.PIRUNDOWN_PORT ?? "3400", 10),
    host: env.PIRUNDOWN_HOST ?? "0.0.0.0",
    apiKey: env.PIRUNDOWN_API_KEY,
    pigatewayUrl: (env.PIRUNDOWN_PIGATEWAY_URL ?? env.PIGATEWAY_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, ""),
    picamUrl: (env.PIRUNDOWN_PICAM_URL ?? env.PICAM_URL ?? "http://127.0.0.1:3300").replace(/\/+$/, ""),
    pilightUrl: (env.PIRUNDOWN_PILIGHT_URL ?? env.PILIGHT_URL ?? "http://127.0.0.1:3200").replace(/\/+$/, ""),
    piprogramUrl: (env.PIRUNDOWN_PIPROGRAM_URL ?? env.PIPROGRAM_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, ""),
    piembedUrl: (env.PIRUNDOWN_PIEMBED_URL ?? env.PIEMBED_URL ?? "http://127.0.0.1:3125").replace(/\/+$/, ""),
    autoConnectGateway: env.PIRUNDOWN_AUTO_CONNECT_GATEWAY !== "false",
    defaultRundownPath: env.PIRUNDOWN_DEFAULT_RUNDOWN_PATH,
    storageDir: env.PIRUNDOWN_STORAGE_DIR ?? join(process.cwd(), "storage"),
  };
}
