import dns from "node:dns";
import net from "node:net";
import { attachDeskSocket, createDeskApp } from "./desk/api.js";
import { loadDeskConfig, loadEnvFiles } from "./desk/config.js";
import { Desk, EventHub } from "./desk/orchestrator.js";

loadEnvFiles();
const cfg = loadDeskConfig();
if (cfg.ipFamily === "4") {
  // Delta API keys are IP-whitelisted; dual-stack hosts otherwise egress over IPv6 and get ip_not_whitelisted_for_api_key.
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(false);
}
const host = process.env.HOST ?? "127.0.0.1";
const desk = new Desk(cfg, new EventHub());
const server = createDeskApp(desk).listen(cfg.port, host, () => {
  process.stdout.write(
    `Crypto Manager desk API on http://${host}:${cfg.port} · Delta India DEMO · instruments ${cfg.instruments.join(", ")} · execution disabled on startup\n`
  );
});
const wss = attachDeskSocket(server, desk);
void desk.start();

function shutdown(): void {
  void desk.stop().then(() => {
    wss.close();
    server.close(() => {
      desk.db.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
