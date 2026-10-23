import { readSseData } from "../util/sse.js";
/** Accumulate SSE across arbitrary byte boundaries; never execute partial tool arguments. */
export async function readChatStream(response: Response): Promise<Record<string, any>> {
  let doneMarker = false; let finished = false;
  const message: Record<string, any> = { role: "assistant", content: "" };
  const reasoning = new Map<string, any>();
  const calls = new Map<number, any>(); let usage: any;
  const event = (data: string) => {
    if (!data) return;
    if (data === "[DONE]") { doneMarker = true; return; }
    const payload = JSON.parse(data);
    if (payload.error) throw new Error("Chat Completions stream failed.");
    if (payload.usage) usage = payload.usage;
    const choice = payload.choices?.[0]; if (!choice) return;
    if (choice.finish_reason && !["stop", "tool_calls"].includes(choice.finish_reason)) throw new Error("Chat Completions stream incomplete.");
    if (choice.finish_reason) finished = true;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") message.content += delta.content;
    if (delta.annotations) (message.annotations ??= []).push(...delta.annotations);
    for (const detail of delta.reasoning_details ?? []) {
      const key = String(detail.index ?? detail.id ?? detail.type);
      const previous = reasoning.get(key) ?? {};
      const merged = { ...previous, ...detail };
      for (const field of ["text", "summary", "data", "signature"]) {
        if (typeof detail[field] === "string") merged[field] = (previous[field] ?? "") + detail[field];
      }
      reasoning.set(key, merged);
    }
    for (const call of delta.tool_calls ?? []) {
      if (!Number.isInteger(call.index) || call.index < 0 || call.index >= 16) throw new Error("Chat Completions tool call limit.");
      const value = calls.get(call.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (call.id) value.id = call.id;
      if (call.type && call.type !== "function") throw new Error("Unsupported tool type.");
      if (call.function?.name) value.function.name += call.function.name;
      if (call.function?.arguments) value.function.arguments += call.function.arguments;
      calls.set(call.index, value);
    }
  };
  for await (const data of readSseData(response, { maxBytes: 4 * 1024 * 1024 })) event(data);
  if (!doneMarker || !finished) throw new Error("Chat Completions stream incomplete.");
  if (reasoning.size) message.reasoning_details = [...reasoning.values()];
  if (calls.size) message.tool_calls = [...calls.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
  return { choices: [{ message }], usage };
}
