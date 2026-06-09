import fs from "node:fs/promises";
import { staticConfig } from "../config.js";
import type { SFPSignalRecord } from "../types.js";

function fmtPrice(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toPrecision(5);
}

function hasSfp(signal: SFPSignalRecord): boolean {
  return signal.hasSfp === true || signal.strategy === "sfp" || /SFP/i.test(signal.patternName ?? "");
}

function buildCaption(signal: SFPSignalRecord): string {
  const side = signal.direction === "BULLISH" ? "LONG" : "SHORT";
  const pattern = signal.patternName ?? (signal.strategy === "sfp" ? "SFP" : "Khong ro");
  const rr = Math.abs(signal.tpPrice - signal.entryPrice) /
    Math.max(Math.abs(signal.entryPrice - signal.slPrice), 1e-12);
  return [
    `TIN HIEU ${side} ${signal.symbol} ${signal.timeframe}`,
    `Mo hinh: ${pattern}`,
    `SFP: ${hasSfp(signal) ? "CO" : "KHONG"}`,
    `Entry: ${fmtPrice(signal.entryPrice)}`,
    `TP: ${fmtPrice(signal.tpPrice)}`,
    `SL: ${fmtPrice(signal.slPrice)}`,
    `Score: ${signal.decisionScore ?? "-"} | RR: ${rr.toFixed(2)}R`,
    signal.chartUrl ? `Chart: ${signal.chartUrl}` : undefined
  ].filter(Boolean).join("\n");
}

export function telegramConfigured(): boolean {
  return Boolean(staticConfig.telegramBotToken && staticConfig.telegramChatId);
}

export async function sendTelegramSignal(signal: SFPSignalRecord): Promise<void> {
  if (!telegramConfigured()) return;
  if (signal.decision !== "TRADE") return;

  const endpoint = `https://api.telegram.org/bot${staticConfig.telegramBotToken}/sendDocument`;
  const form = new FormData();
  form.append("chat_id", staticConfig.telegramChatId);
  form.append("caption", buildCaption(signal).slice(0, 1024));
  form.append("parse_mode", "HTML");

  if (signal.chartPath) {
    const content = await fs.readFile(signal.chartPath);
    const payload = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    form.append("document", new Blob([payload], { type: "image/svg+xml" }), `signal-${signal.id}.svg`);
  } else if (signal.chartUrl) {
    form.append("document", signal.chartUrl);
  } else {
    throw new Error("Khong co chart de gui Telegram");
  }

  const response = await fetch(endpoint, { method: "POST", body: form });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram sendDocument failed ${response.status}: ${text.slice(0, 250)}`);
  }
}
