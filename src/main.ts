import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, gatewayClient } = await buildApp(config);

  try {
    const address = await app.listen({ port: config.port, host: config.host });
    app.log.info(`pirundown server listening on ${address}`);

    if (config.autoConnectGateway) {
      gatewayClient.start();
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down...`);
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
