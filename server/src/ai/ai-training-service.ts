import { appEvents } from "../events.js";
import { aiCredentialsStatus, saveAICredentials, staticConfig } from "../config.js";
import type { AITrainingDocument, AITrainingDocumentKind, AITrainingRun } from "../types.js";
import { AppDatabase } from "../db/database.js";
import { AuditLogService } from "../services/audit-log.js";

type AIConfigPatch = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type AIMessageContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

const DEFAULT_SYSTEM_PROMPT = [
  "Bạn là AI nghiên cứu chiến lược crypto futures cho Binance USD-M.",
  "Nhiệm vụ: đọc tài liệu, prompt và ảnh chart do người dùng cung cấp; rút ra chiến lược có rule rõ ràng.",
  "Không đưa lời khuyên tài chính chắc chắn. Không được tạo chiến lược mơ hồ.",
  "Luôn trả về JSON hợp lệ với các trường: strategy_name, market_context, entry_rules, filters, stop_loss, take_profit, invalidation, risk_limits, implementation_notes, test_plan.",
  "Mọi rule phải có điều kiện định lượng hoặc điều kiện quan sát cụ thể."
].join("\n");

export class AITrainingService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditLogService
  ) {}

  config() {
    return aiCredentialsStatus();
  }

  saveConfig(patch: AIConfigPatch) {
    const next = saveAICredentials(patch);
    this.audit.info("Đã lưu cấu hình AI", {
      baseUrl: next.baseUrl,
      model: next.model,
      configured: next.configured,
      apiKeyPreview: next.apiKeyPreview
    });
    return next;
  }

  async testConnection(): Promise<{ ok: boolean; model: string; baseUrl: string; latencyMs: number; output: string }> {
    this.assertConfigured();
    const started = Date.now();
    const output = await this.callModel([
      { type: "input_text", text: "Trả lời ngắn gọn bằng JSON: {\"ok\":true,\"message\":\"connected\"}" }
    ]);
    const result = {
      ok: true,
      model: staticConfig.aiModel,
      baseUrl: staticConfig.aiBaseUrl,
      latencyMs: Date.now() - started,
      output
    };
    this.audit.info("AI test kết nối thành công", {
      model: result.model,
      baseUrl: result.baseUrl,
      latencyMs: result.latencyMs
    });
    return result;
  }

  listDocuments(limit = 100): AITrainingDocument[] {
    return this.db.listAITrainingDocuments(limit);
  }

  addDocument(input: {
    name?: string;
    kind?: string;
    mimeType?: string;
    content?: string;
    tags?: string[];
  }): AITrainingDocument {
    const name = String(input.name ?? "").trim();
    const content = String(input.content ?? "");
    if (!name) throw new Error("Tên tài liệu không được để trống");
    if (!content.trim()) throw new Error("Nội dung tài liệu không được để trống");
    if (content.length > 5_500_000) throw new Error("File quá lớn. Giới hạn hiện tại khoảng 5MB mỗi file.");

    const saved = this.db.insertAITrainingDocument({
      name,
      kind: normalizeDocumentKind(input.kind),
      mimeType: String(input.mimeType ?? "text/plain").trim() || "text/plain",
      content,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      tags: Array.isArray(input.tags) ? input.tags.map(String).filter(Boolean).slice(0, 20) : [],
      createdAt: new Date().toISOString()
    });
    this.audit.info("Đã thêm tài liệu huấn luyện AI", {
      id: saved.id,
      name: saved.name,
      kind: saved.kind,
      sizeBytes: saved.sizeBytes
    });
    return saved;
  }

  deleteDocument(id: number): { ok: boolean } {
    const ok = this.db.deleteAITrainingDocument(id);
    if (ok) this.audit.info("Đã xóa tài liệu huấn luyện AI", { id });
    return { ok };
  }

  listRuns(limit = 30): AITrainingRun[] {
    return this.db.listAITrainingRuns(limit);
  }

  async analyze(input: { prompt?: string; documentIds?: number[] }): Promise<AITrainingRun> {
    this.assertConfigured();
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) throw new Error("Prompt phân tích không được để trống");

    const documentIds = Array.isArray(input.documentIds)
      ? input.documentIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    const documents = this.db.getAITrainingDocuments(documentIds);
    const content = this.buildTrainingContent(prompt, documents);

    const createdAt = new Date().toISOString();
    try {
      const output = await this.callModel(content);
      const parsedJson = parseJsonFromText(output);
      const run = this.db.insertAITrainingRun({
        prompt,
        documentIds,
        model: staticConfig.aiModel,
        status: "ok",
        output,
        parsedJson,
        createdAt
      });
      this.audit.info("AI đã tạo bản nháp chiến lược", {
        id: run.id,
        model: run.model,
        documents: documentIds.length
      });
      appEvents.publish("ai.training", { id: run.id, status: run.status });
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const run = this.db.insertAITrainingRun({
        prompt,
        documentIds,
        model: staticConfig.aiModel,
        status: "error",
        output: "",
        error: message,
        createdAt
      });
      this.audit.error("AI phân tích thất bại", { id: run.id, error: message });
      appEvents.publish("ai.training", { id: run.id, status: run.status, error: message });
      throw error;
    }
  }

  private buildTrainingContent(prompt: string, documents: AITrainingDocument[]): AIMessageContent[] {
    const textDocs = documents.filter((doc) => !doc.mimeType.startsWith("image/"));
    const imageDocs = documents.filter((doc) => doc.mimeType.startsWith("image/")).slice(0, 6);

    const text = [
      DEFAULT_SYSTEM_PROMPT,
      "",
      "Yêu cầu của người dùng:",
      prompt,
      "",
      "Tài liệu text/prompt đã chọn:",
      ...textDocs.map((doc, index) => [
        `--- DOC ${index + 1}: ${doc.name} (${doc.kind}) ---`,
        truncate(doc.content, 18_000)
      ].join("\n"))
    ].join("\n");

    const content: AIMessageContent[] = [{ type: "input_text", text }];
    for (const image of imageDocs) {
      content.push({ type: "input_image", image_url: image.content });
    }
    return content;
  }

  private async callModel(content: AIMessageContent[]): Promise<string> {
    try {
      return await this.callResponses(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/404|not found|unsupported|responses/i.test(message)) throw error;
      return await this.callChatCompletions(content);
    }
  }

  private async callResponses(content: AIMessageContent[]): Promise<string> {
    const response = await fetch(`${staticConfig.aiBaseUrl}/responses`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: staticConfig.aiModel,
        input: [{ role: "user", content }],
        max_output_tokens: 2500
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`AI Responses lỗi ${response.status}: ${extractError(data)}`);
    return extractResponsesText(data);
  }

  private async callChatCompletions(content: AIMessageContent[]): Promise<string> {
    const chatContent = content.map((item) => item.type === "input_image"
      ? { type: "image_url", image_url: { url: item.image_url } }
      : { type: "text", text: item.text }
    );
    const response = await fetch(`${staticConfig.aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: staticConfig.aiModel,
        messages: [{ role: "user", content: chatContent }],
        max_tokens: 2500
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`AI Chat lỗi ${response.status}: ${extractError(data)}`);
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === "string" ? text : JSON.stringify(data);
  }

  private headers(): Record<string, string> {
    return {
      "Authorization": `Bearer ${staticConfig.aiApiKey}`,
      "Content-Type": "application/json"
    };
  }

  private assertConfigured(): void {
    if (!staticConfig.aiApiKey) throw new Error("Chưa cấu hình AI API key");
    if (!staticConfig.aiBaseUrl) throw new Error("Chưa cấu hình AI Base URL");
    if (!staticConfig.aiModel) throw new Error("Chưa cấu hình AI model");
  }
}

function normalizeDocumentKind(value: string | undefined): AITrainingDocumentKind {
  const clean = String(value ?? "other").trim();
  const allowed: AITrainingDocumentKind[] = ["text", "image", "prompt", "candlestick", "strategy", "other"];
  return allowed.includes(clean as AITrainingDocumentKind) ? (clean as AITrainingDocumentKind) : "other";
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n...[truncated]`;
}

function extractError(data: unknown): string {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const err = obj.error;
    if (err && typeof err === "object" && "message" in err) {
      return String((err as Record<string, unknown>).message);
    }
    if (typeof err === "string") return err;
  }
  return JSON.stringify(data);
}

function extractResponsesText(data: unknown): string {
  if (data && typeof data === "object") {
    const outputText = (data as Record<string, unknown>).output_text;
    if (typeof outputText === "string" && outputText.trim()) return outputText;
    const output = (data as Record<string, unknown>).output;
    if (Array.isArray(output)) {
      const parts: string[] = [];
      for (const item of output) {
        const content = item && typeof item === "object" ? (item as Record<string, unknown>).content : undefined;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part && typeof part === "object") {
            const text = (part as Record<string, unknown>).text;
            if (typeof text === "string") parts.push(text);
          }
        }
      }
      if (parts.length > 0) return parts.join("\n");
    }
  }
  return JSON.stringify(data);
}

function parseJsonFromText(text: string): unknown | undefined {
  const direct = tryParseJson(text);
  if (direct !== undefined) return direct;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsed = tryParseJson(fenced);
    if (parsed !== undefined) return parsed;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParseJson(text.slice(start, end + 1));
  return undefined;
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
