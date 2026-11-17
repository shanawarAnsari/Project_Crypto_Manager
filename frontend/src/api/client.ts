import type {
  AiDecisionResponse,
  AgentSnapshot,
  AgentTimeframe,
  CandleResponse,
  Dashboard,
  DemoTestEntryPreview,
  SignalPreview,
  StrategyConfig,
  StrategyTimeframe,
  Timeframe,
} from "../domain/types";

export class ApiError extends Error {
  readonly status?: number;

  constructor(
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError("Could not reach the Sunny API. Check the connection and try again.");
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof body.message === "string"
      ) {
        message = body.message;
      }
    } catch {
      // Keep the status message when the server does not return JSON.
    }
    throw new ApiError(message, response.status);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError("The Sunny API returned an invalid response.");
  }
}

export const api = {
  dashboard: () => request<Dashboard>("/api/dashboard"),
  signalPreview: () => request<SignalPreview>("/api/signal/preview"),
  candles: (timeframe: Timeframe, limit?: number) =>
    request<CandleResponse>(
      `/api/candles?tf=${encodeURIComponent(timeframe)}${limit === undefined ? "" : `&limit=${limit}`}`,
    ),
  saveStrategy: (strategy: StrategyConfig) =>
    request<{ strategy: StrategyConfig }>("/api/strategy", {
      method: "POST",
      body: JSON.stringify(strategy),
    }),
  reevaluateAi: (timeframe: StrategyTimeframe) =>
    request<AiDecisionResponse>("/api/ai/decision", {
      method: "POST",
      body: JSON.stringify({ timeframe }),
    }),
  toggleBot: (enabled: boolean) =>
    request<{ enabled: boolean }>("/api/bot/toggle", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  triggerKillSwitch: (active = true) =>
    request<{
      accepted: boolean;
      exchangeActions: {
        status: "succeeded" | "partial" | "failed" | "unavailable" | "not_attempted";
        cancelOrders?: "succeeded" | "failed" | "unconfirmed";
        closePositions?: "succeeded" | "failed" | "unconfirmed";
        reason?: string;
      };
    }>("/api/kill-switch", {
      method: "POST",
      body: JSON.stringify({ active }),
    }),
  agent: () => request<AgentSnapshot>("/api/agent"),
  sendAgentMessage: (message: string) =>
    request<{ accepted: true }>("/api/agent/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  saveAgentSettings: (timeframe: AgentTimeframe) =>
    request<AgentSnapshot>("/api/agent/settings", {
      method: "POST",
      body: JSON.stringify({ timeframe }),
    }),
  previewTestEntry: (side: "buy" | "sell") =>
    request<DemoTestEntryPreview>("/api/agent/test-entry/preview", {
      method: "POST",
      body: JSON.stringify({ side }),
    }),
  confirmTestEntry: (token: string) =>
    request<AgentSnapshot>("/api/agent/test-entry/confirm", {
      method: "POST",
      body: JSON.stringify({ token, confirmation: "PLACE_DEMO_TEST_ORDER" }),
    }),
  agentEvents: (after?: number) =>
    new EventSource(`/api/agent/events${after === undefined ? "" : `?after=${after}`}`),
};
