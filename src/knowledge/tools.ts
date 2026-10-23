import type { RuntimeTool } from "../runtime/types.js";
import { LocalKnowledgeStore, RecentDeletedError, MAX_RECENT_DELETE, type ConversationState } from "./store.js";

const MAX_RESULTS = 20;
export const LOCAL_KNOWLEDGE_TOOL_NAMES = {
  recentRead: "gateway_recent_read",
  recentCreate: "gateway_recent_create",
  recentWrite: "gateway_recent_write",
  recentDelete: "gateway_recent_delete",
} as const;

export const LOCAL_KNOWLEDGE_TOOLS: RuntimeTool[] = [
  {
    name: LOCAL_KNOWLEDGE_TOOL_NAMES.recentRead, readOnly: true,
    description: "只读浏览正式会话 Recent。提供 id 获取完整条目，或按 query 子串筛选近期话题。返回确切交流状态与状态日期；null 是未知，不得当作 Done。offset/limit 用于分页。",
    parameters: { type: "object", additionalProperties: false, properties: {
      id: { type: "string" }, query: { type: "string" },
      offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 },
    } },
  },
  {
    name: LOCAL_KNOWLEDGE_TOOL_NAMES.recentCreate, readOnly: false,
    description: "新增正式 Recent 独立话题，包括用户提供的可靠安排。未知交流状态用 null；确切日程提供带时区的 event_at。不要编造日期，也不要创建重复话题。",
    parameters: { type: "object", additionalProperties: false, required: ["body"], properties: {
      body: { type: "string" },
      conversation_state: { type: ["string", "null"], enum: ["Pending", "Ongoing", "Done", null] },
      state_date: { type: ["string", "null"] },
      event_at: { type: ["string", "null"] },
    } },
  },
  {
    name: LOCAL_KNOWLEDGE_TOOL_NAMES.recentWrite, readOnly: false,
    description: "更新正式 Recent 已有条目；必须先 read 获取 id 和 expected_revision。仅交流状态实际变化时提供 state_date（Asia/Shanghai YYYY-MM-DD）；普通正文变更不重置该日期。不能猜测未知交流状态。",
    parameters: { type: "object", additionalProperties: false, required: ["id", "expected_revision"], properties: {
      id: { type: "string" }, expected_revision: { type: "integer", minimum: 1 },
      body: { type: "string" }, conversation_state: { type: ["string", "null"], enum: ["Pending", "Ongoing", "Done", null] },
      state_date: { type: ["string", "null"] },
      event_at: { type: ["string", "null"] },
    } },
  },
  {
    name: LOCAL_KNOWLEDGE_TOOL_NAMES.recentDelete, readOnly: false,
    description: "立即删除正式 Recent 的无用条目。先 read 定位每个 id 与当前 expected_revision，再提供 1–20 个 items；同批全部成功或全部不变。不限保存天数或交流状态，无需先标记 Done。删除不改原始聊天记录。已删稳定 ID/来源的重放不会重新创建。",
    parameters: { type: "object", additionalProperties: false, required: ["items"], properties: {
      items: { type: "array", minItems: 1, maxItems: MAX_RECENT_DELETE, items: {
        type: "object", additionalProperties: false, required: ["id", "expected_revision"], properties: {
          id: { type: "string" }, expected_revision: { type: "integer", minimum: 1 },
        },
      } },
    } },
  },
];

/** Legacy schemas keep their existing tools until an explicit structural migration. */
export function localKnowledgeTools(store: LocalKnowledgeStore): RuntimeTool[] {
  return LOCAL_KNOWLEDGE_TOOLS.filter(tool => store.supportsContextTools || tool.name !== LOCAL_KNOWLEDGE_TOOL_NAMES.recentDelete);
}

function stringArg(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined) {
    if (required) throw new Error("缺少字段：" + key);
    return undefined;
  }
  if (typeof value !== "string" || (required && !value.trim())) throw new Error("字段必须是字符串：" + key);
  return value;
}
function nullableString(args: Record<string, unknown>, key: string): string | null | undefined {
  const value = args[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new Error("字段必须是字符串或 null：" + key);
  return value;
}
function integerArg(args: Record<string, unknown>, key: string, defaultValue: number, min: number, max: number): number {
  const value = args[key] ?? defaultValue;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("无效整数：" + key);
  }
  return value;
}
function assertFields(args: Record<string, unknown>, allowed: readonly string[]): void {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数无效。");
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error("未授权字段：" + key);
}
function metadata<T extends { body: string }>(items: T[]) {
  return items.map(({ body, ...item }) => ({ ...item, preview: body.slice(0, 260), bodyChars: body.length }));
}

/** Intended for injection into the approved formal runtime ONLY. Never call in ephemeral mode. */
export function executeLocalKnowledgeTool(
  store: LocalKnowledgeStore,
  mode: "formal" | "ephemeral",
  name: string,
  args: Record<string, unknown>,
  trustedSourceId?: string,
): unknown {
  if (mode !== "formal") throw new Error("临时 会话禁止访问正式 Recent。");
  switch (name) {
    case LOCAL_KNOWLEDGE_TOOL_NAMES.recentRead: {
      assertFields(args, ["id", "query", "offset", "limit"]);
      const id = stringArg(args, "id");
      if (id) {
        const entry = store.getRecent(id);
        return entry ? { found: true, entry } : { found: false };
      }
      const query = (stringArg(args, "query") ?? "").toLocaleLowerCase();
      const offset = integerArg(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = integerArg(args, "limit", 10, 1, MAX_RESULTS);
      const matched = store.listRecent().filter((item) => item.body.toLocaleLowerCase().includes(query));
      return { total: matched.length, items: metadata(matched.slice(offset, offset + limit)),
        nextOffset: offset + limit < matched.length ? offset + limit : null };
    }
    case LOCAL_KNOWLEDGE_TOOL_NAMES.recentCreate: {
      assertFields(args, ["body", "conversation_state", "state_date", "event_at"]);
      const body = stringArg(args, "body", true)!;
      const conversationState = nullableString(args, "conversation_state") as ConversationState | null | undefined;
      const stateDate = nullableString(args, "state_date");
      const eventAt = nullableString(args, "event_at");
      try {
        return { created: store.createRecent({ body,
          ...(trustedSourceId ? { sourceId: trustedSourceId } : {}),
          ...(conversationState !== undefined ? { conversationState } : {}),
          ...(stateDate !== undefined ? { stateDate } : {}),
          ...(eventAt !== undefined ? { eventAt } : {}),
        }) };
      } catch (error) {
        if (error instanceof RecentDeletedError) return { created: null, deleted: true,
          id: error.deletion.id, message: "该来源对应的 Recent 已删除，未重新创建。" };
        throw error;
      }
    }
    case LOCAL_KNOWLEDGE_TOOL_NAMES.recentWrite: {
      assertFields(args, ["id", "expected_revision", "body", "conversation_state", "state_date", "event_at"]);
      const id = stringArg(args, "id", true)!;
      const expectedRevision = integerArg(args, "expected_revision", -1, 1, Number.MAX_SAFE_INTEGER);
      const body = stringArg(args, "body");
      const conversationState = nullableString(args, "conversation_state") as ConversationState | null | undefined;
      const stateDate = nullableString(args, "state_date");
      const eventAt = nullableString(args, "event_at");
      if (body === undefined && conversationState === undefined && stateDate === undefined && eventAt === undefined) throw new Error("没有提供需要更新的字段。");
      return { updated: store.updateRecent({ id, expectedRevision,
        ...(body !== undefined ? { body } : {}),
        ...(conversationState !== undefined ? { conversationState } : {}),
        ...(stateDate !== undefined ? { stateDate } : {}),
        ...(eventAt !== undefined ? { eventAt } : {}) }) };
    }
    case LOCAL_KNOWLEDGE_TOOL_NAMES.recentDelete: {
      assertFields(args, ["items"]);
      if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > MAX_RECENT_DELETE) throw new Error("items 需要包含 1–20 个条目。");
      const targets = args.items.map(item => {
        assertFields(item, ["id", "expected_revision"]);
        return { id: stringArg(item, "id", true)!,
          expectedRevision: integerArg(item, "expected_revision", -1, 1, Number.MAX_SAFE_INTEGER) };
      });
      return store.deleteRecent(targets);
    }
    default:
      throw new Error("未知本地工具：" + name);
  }
}
