import { createHmac } from "node:crypto";

export function createDeltaSignature(
  secret: string,
  method: string,
  timestamp: string,
  pathAndQuery: string,
  body: string
): string {
  return createHmac("sha256", secret)
    .update(`${method}${timestamp}${pathAndQuery}${body}`)
    .digest("hex");
}
