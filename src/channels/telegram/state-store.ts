import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../../util/atomic-json.js";
import { SerialQueue } from "../../util/serial-queue.js";
import type { TelegramState } from "./types.js";
export class TelegramStateStore {
  state: TelegramState = { offset: 0 };
  private readonly operations = new SerialQueue();
  readonly path: string;
  constructor(dataDir: string) { this.path = join(dataDir, "channels", "telegram.json"); }
  async load(): Promise<TelegramState> {
    return this.operations.run(async () => {
      const state = await readJsonFile<TelegramState>(this.path, this.state);
      if (!Number.isSafeInteger(state.offset) || state.offset < 0) throw new Error("Invalid Telegram offset state.");
      this.state = state;
      return state;
    });
  }
  mutate<T>(mutator: () => T): Promise<T> {
    return this.operations.run(async () => {
      const result = mutator();
      await writeJsonAtomic(this.path, this.state);
      return result;
    });
  }
}
