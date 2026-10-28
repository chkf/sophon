/** Ordered, delivery-ready fragments. Hidden stage directions never enter this list. */
export type ReplySegment =
  | { kind: "text" | "stage_direction"; text: string }
  | { kind: "voice"; text: string; instruction: string };


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

/** Dialogue is literal text; stage directions arrive through a separate typed field. */
export function splitStageDirections(text: string): ReplySegment[] {
  return text.trim() ? [{kind: "text", text: text.trim()}] : [];
}
export function spokenText(text: string): string { return text.trim(); }
export function displayText(text: string, _show: boolean): string { return text.trim(); }
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
