import { fork, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createApp } from "./app.js";
import { createServices } from "./services.js";
import { LiveCandleHub, parseWorkerCandleMessage, toLiveCandleEvent } from "./live/live-candle-hub.js";
import { TradingAgent } from "./ai/trading-agent.js";
import { AgentRepository } from "./ai/agent-repository.js";
import { NvidiaAgentModel } from "./ai/agent-model.js";

const services = createServices();
const agent = new TradingAgent(services, new AgentRepository(services.db),
  new NvidiaAgentModel(services.config.nimApiKey, services.config.nimBaseUrl, services.config.aiModel));
agent.start();
const serverScript = process.argv[1] ?? "";
const runningTypeScript = serverScript.endsWith(".ts");
const workerScript = resolve(dirname(serverScript), runningTypeScript ? "worker.ts" : "worker.js");
const worker: ChildProcess = fork(workerScript, [], {
  stdio: "inherit",
  execArgv: runningTypeScript ? ["--import", "tsx"] : process.execArgv
});
let shuttingDown = false;
worker.on("error", () => {
  services.status.set("worker_status", "failed");
  services.botState.update({ enabled: false, killSwitch: true });
  process.stderr.write("Worker process could not be started; trading remains unavailable.\n");
});
worker.on("spawn", () => services.status.set("worker_status", "running"));
worker.on("exit", () => {
  services.status.set("worker_status", "stopped");
  if (!shuttingDown) {
    services.botState.update({ enabled: false, killSwitch: true });
    process.stderr.write("Worker process exited; local trading has been halted and requires operator attention.\n");
  }
});
const server = createApp(services, agent).listen(services.config.port, "0.0.0.0", () => {
  process.stdout.write(`Sunny Crypto Manager API listening on port ${services.config.port}\n`);
});
const liveCandles = new LiveCandleHub();
liveCandles.attach(server);
worker.on("message", (message: unknown) => {
  const candle = parseWorkerCandleMessage(message);
  if (candle) liveCandles.broadcast(toLiveCandleEvent(candle));
});

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const stopAgent = agent.stop();
  services.botState.update({ enabled: false });
  const stopWorker = new Promise<void>((resolve) => {
    if (worker.exitCode !== null || worker.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      worker.kill("SIGKILL");
      resolve();
    }, 10_000);
    timeout.unref();
    worker.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    worker.kill("SIGTERM");
  });
  const stopHttp = new Promise<void>((resolve) => {
    liveCandles.close();
    server.close(() => resolve());
    server.closeAllConnections();
  });
  void Promise.all([stopWorker, stopHttp, stopAgent]).then(() => {
    services.db.close();
    process.exitCode = 0;
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
