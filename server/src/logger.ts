import { staticConfig } from "./config.js";

const levels = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof levels)[number];

function shouldLog(level: LogLevel): boolean {
  return levels.indexOf(level) >= levels.indexOf(staticConfig.logLevel);
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function redact(value: unknown): unknown {
  const apiKey = staticConfig.apiKey;
  const apiSecret = staticConfig.apiSecret;
  const replaceSecrets = (text: string) =>
    text
      .replaceAll(apiKey, apiKey ? maskSecret(apiKey) : "")
      .replaceAll(apiSecret, apiSecret ? maskSecret(apiSecret) : "");

  if (typeof value === "string") return replaceSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        if (/api|secret|signature|key/i.test(key)) return [key, "[REDACTED]"];
        return [key, redact(item)];
      })
    );
  }
  return value;
}

export const logger = {
  debug(message: string, context?: unknown) {
    if (shouldLog("debug")) console.debug(message, redact(context ?? ""));
  },
  info(message: string, context?: unknown) {
    if (shouldLog("info")) console.info(message, redact(context ?? ""));
  },
  warn(message: string, context?: unknown) {
    if (shouldLog("warn")) console.warn(message, redact(context ?? ""));
  },
  error(message: string, context?: unknown) {
    if (shouldLog("error")) console.error(message, redact(context ?? ""));
  }
};
