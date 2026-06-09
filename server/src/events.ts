import { EventEmitter } from "node:events";
import type { AppEvent } from "./types.js";

class AppEventBus extends EventEmitter {
  publish(type: AppEvent["type"], data: unknown): AppEvent {
    const event: AppEvent = {
      type,
      data,
      createdAt: new Date().toISOString()
    };
    this.emit("event", event);
    return event;
  }
}

export const appEvents = new AppEventBus();
