import { displayText } from "./reply-segments.js";

/** A text resembling a serialized function call is not an executable tool call.
 * Never parse and execute it: that would bypass provider tool authorization.
 * This only catches whole-message pseudo calls, not ordinary explanations or code samples.
 */
export function textualToolCall(text:string,offered:readonly string[]):boolean {
  let value=displayText(text,false).trim();
  if(!value)return false;
  const fence=value.match(/^\x60\x60\x60(?:json|javascript|text)?\s*\n([\s\S]*?)\n\x60\x60\x60$/i);
  if(fence)value=fence[1]!.trim();
  const advertised=new Set(offered);
  // Match common model-emitted fake function call formats, only at message start.
  const target=value.match(/^(?:<\|assistant\|>\s*)?(?:assistant\s+)?to=(?:gateway|functions|tools)\.([a-zA-Z_][\w.-]*)\b/i);
  if(target)return Boolean(target[1]);
  if(/^<(?:function_call|tool_call)\b/i.test(value) || /^<\|tool_call\|>/i.test(value))return true;
  if(!/^\{/.test(value))return false;
  try{
    const parsed:unknown=JSON.parse(value);
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return false;
    const obj=parsed as Record<string,unknown>;
    const name=typeof obj.name==="string"?obj.name:typeof obj.tool==="string"?obj.tool
      :obj.function&&typeof obj.function==="object"&&typeof (obj.function as Record<string,unknown>).name==="string"
        ? String((obj.function as Record<string,unknown>).name) : undefined;
    return Boolean(name&&/^[A-Za-z_][\w.-]{0,100}$/.test(name)&&
      (advertised.has(name) || name==="send_voice" || name.startsWith("gateway_")) &&
      ("arguments" in obj || "parameters" in obj || "args" in obj || "function" in obj));
  }catch{return false;}
}

export function blockTextualToolCall(text:string,offered:readonly string[],provider:"openrouter"|"siwc"|"api"):string {
  if(!textualToolCall(text,offered))return text;
  console.error("[runtime-tool-integrity] provider="+provider+" emitted a text-only tool call; no function_call event, not executed.");
  return "刚才模型只输出了工具调用文字，没有真正调用工具；因此操作未执行。请重新发起请求。";
}
