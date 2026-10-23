/** Ordered, delivery-ready fragments. Hidden stage directions never enter this list. */
export type ReplySegment =
  | { kind: "text" | "stage_direction"; text: string }
  | { kind: "voice"; text: string; instruction: string };

const CODE_SPANS = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`/g;

/** Keep fenced code intact when separating ordinary text bubbles. */
export function replyParagraphs(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g)) {
    result.push(...text.slice(start, match.index).split(/\n\s*\n/), match[0]);
    start = match.index! + match[0].length;
  }
  result.push(...text.slice(start).split(/\n\s*\n/));
  return result.map(value => value.trim()).filter(Boolean);
}

/** Full-width parentheses are reserved for role performance by the reply protocol.
 * Nested/multiline directions are supported; an unfinished direction is fail-closed.
 * ASCII parentheses in ordinary prose/code retain their usual meaning.
 */
export function splitStageDirections(text: string): ReplySegment[] {
  const result: ReplySegment[] = [];
  let start = 0, depth = 0, stageStart = 0;
  const code = new Map([...text.matchAll(CODE_SPANS)].map(match => [match.index, match[0].length]));
  const push = (kind: "text" | "stage_direction", value: string) => {
    if (value.trim()) result.push({ kind, text: value.trim() });
  };
  for (let i = 0; i < text.length; i++) {
    // Code is literal reply data, not role performance. Backticks inside an
    // already open direction do not turn its hidden body into ordinary text.
    if (depth === 0 && code.has(i)) { i += code.get(i)! - 1; continue; }
    if (text[i] === "（") {
      if (depth++ === 0) { push("text", text.slice(start, i)); stageStart = i; }
    } else if (text[i] === "）" && depth > 0 && --depth === 0) {
      push("stage_direction", text.slice(stageStart, i + 1)); start = i + 1;
    }
  }
  if (depth === 0) push("text", text.slice(start));
  return result;
}
export function spokenText(text: string): string {
  return splitStageDirections(text).filter(part => part.kind === "text").map(part => part.text).join(" ");
}
export function displayText(text: string, show: boolean): string {
  return splitStageDirections(text).filter(part => show || part.kind !== "stage_direction").map(part => part.text).join("\n\n");
}
export function replyText(segments: readonly ReplySegment[]): string {
  return segments.map(part => part.text).join("\n\n");
}
/** Reapply the current global switch to recovered provider/channel payloads too. */
export function visibleSegments(segments: readonly ReplySegment[], show: boolean, voice = true): ReplySegment[] {
  return segments.flatMap(part => {
    if (part.kind === "stage_direction") return show ? [{ ...part }] : [];
    if (part.kind === "voice") {
      const text = spokenText(part.text);
      return text ? [voice ? { ...part, text } : { kind: "text" as const, text }] : [];
    }
    return splitStageDirections(part.text).filter(item => show || item.kind !== "stage_direction");
  });
}
