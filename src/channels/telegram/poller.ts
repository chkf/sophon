import type { TelegramApiClient, TelegramUpdate } from "./types.js";
import { TelegramBotApiError } from "./api.js";
export async function pollTelegram(api: TelegramApiClient, signal: AbortSignal,
  active: () => boolean, offset: () => number, processUpdate: (update: TelegramUpdate) => Promise<void>,
  conflict: () => void): Promise<void> {
    while (active() && !signal.aborted) {
      try {
        const updates = await api.call<TelegramUpdate[]>("getUpdates", {
          offset: offset(),
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        }, 50_000, signal);
        for (const update of updates) await processUpdate(update);
      } catch (error) {
        if (!active() || signal.aborted) break;
        if (
          error instanceof TelegramBotApiError &&
          error.errorCode === 409 &&
          /conflict|other getupdates request/i.test(error.message)
        ) {
          console.error(
            "[telegram] poll handoff: another getUpdates poller took ownership; this instance is yielding.",
          );
          conflict();
          break;
        }
        const timedOut =
          error instanceof Error &&
          (error.name === "TimeoutError" || /aborted due to timeout/i.test(error.message));
        if (!timedOut) {
          console.error("[telegram] poll error:", error instanceof Error ? error.message : error);
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    }
  }
