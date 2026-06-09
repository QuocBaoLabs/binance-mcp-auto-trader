import { appEvents } from "../events.js";
import { logger, redact } from "../logger.js";
import { AppDatabase } from "../db/database.js";

export class AuditLogService {
  constructor(private readonly db: AppDatabase) {}

  debug(message: string, context?: unknown): void {
    logger.debug(message, context);
    this.persist("debug", message, context);
  }

  info(message: string, context?: unknown): void {
    logger.info(message, context);
    this.persist("info", message, context);
  }

  warn(message: string, context?: unknown): void {
    logger.warn(message, context);
    this.persist("warn", message, context);
  }

  error(message: string, context?: unknown): void {
    logger.error(message, context);
    this.persist("error", message, context);
  }

  private persist(level: string, message: string, context?: unknown): void {
    const safeContext = redact(context);
    this.db.insertLog(level, message, safeContext);
    appEvents.publish("log.created", { level, message, context: safeContext });
  }
}
