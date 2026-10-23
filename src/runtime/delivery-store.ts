import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { rename } from "node:fs/promises";
import { readJsonFile, writeJsonAtomic, removeJson } from "../util/atomic-json.js";
import { address, removeDocument } from "../state/database.js";
import type { ProviderId } from "./types.js";
export interface DeliveryTicket {
  version?: 1 | 2; provider: ProviderId; id: string; deliveryId?: string; sessionId?: string;
  /** A durable channel receipt is being recorded; do not replace it with a new turn. */
  recordPending?: true;
}
export type BoundDeliveryTicket = DeliveryTicket & { version: 2; deliveryId: string; sessionId: string };
export class ProviderDeliveryStore {
  constructor(private readonly root: string) {}
  private path(sessionId: string): string { return join(this.root, createHash("sha256").update(sessionId).digest("hex") + ".json"); }
  async read(sessionId: string): Promise<DeliveryTicket | undefined> {
    const ticket = await readJsonFile<DeliveryTicket | undefined>(this.path(sessionId), undefined);
    if (ticket && ((ticket.version !== undefined && ticket.version !== 1 && ticket.version !== 2) || !["siwc", "openrouter", "api"].includes(ticket.provider) || typeof ticket.id !== "string" || !ticket.id ||
      (ticket.version === 2 && (ticket.sessionId !== sessionId || typeof ticket.deliveryId !== "string" || !ticket.deliveryId)) ||
      (ticket.recordPending !== undefined && (ticket.version !== 2 || ticket.recordPending !== true)))) throw new Error("Invalid delivery ticket.");
    return ticket;
  }
  write(sessionId: string, ticket: DeliveryTicket): Promise<void> { return writeJsonAtomic(this.path(sessionId), { version: 1, ...ticket }); }
  async archiveLegacy(sessionId: string): Promise<void> {
    const path = this.path(sessionId), archived = path + "." + randomUUID() + ".legacy-recovery";
    if (!removeDocument(path, address(archived)?.key)) await rename(path, archived);
  }
  remove(sessionId: string): Promise<void> { return removeJson(this.path(sessionId)); }
}
