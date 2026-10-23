const DEFAULT_MAX_BUBBLE_CHARS = 280;
const MAX_BUBBLE_COUNT = 10;

function hardSplit(text: string, maxLength: number): string[] {
  const parts: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    const floor = Math.floor(maxLength * 0.55);
    const candidates = [
      remaining.lastIndexOf("。", maxLength),
      remaining.lastIndexOf("！", maxLength),
      remaining.lastIndexOf("？", maxLength),
      remaining.lastIndexOf("；", maxLength),
      remaining.lastIndexOf("，", maxLength),
      remaining.lastIndexOf("\n", maxLength),
      remaining.lastIndexOf(" ", maxLength),
    ].filter((index) => index >= floor);

    const cut = candidates.length ? Math.max(...candidates) + 1 : maxLength;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
}

function splitProse(text: string, maxLength: number): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((value) => value.trim())
    .filter(Boolean);

  const parts: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxLength) {
      parts.push(paragraph);
      continue;
    }

    const sentences = paragraph
      .split(/(?<=[。！？；!?])\s*|(?<=[.!?])\s+/u)
      .map((value) => value.trim())
      .filter(Boolean);

    let current = "";
    for (const sentence of sentences.length ? sentences : [paragraph]) {
      if (sentence.length > maxLength) {
        if (current) {
          parts.push(current);
          current = "";
        }
        parts.push(...hardSplit(sentence, maxLength));
        continue;
      }

      const candidate = current ? current + " " + sentence : sentence;
      if (candidate.length > maxLength) {
        parts.push(current);
        current = sentence;
      } else {
        current = candidate;
      }
    }
    if (current) parts.push(current);
  }

  return parts;
}

function capBubbleCount(parts: string[], maxCount = MAX_BUBBLE_COUNT): string[] {
  if (parts.length <= maxCount) return parts;

  const capped: string[] = [];
  for (let index = 0; index < maxCount; index += 1) {
    const start = Math.floor((index * parts.length) / maxCount);
    const end = Math.floor(((index + 1) * parts.length) / maxCount);
    capped.push(parts.slice(start, end).join("\n\n"));
  }
  return capped;
}

function tokenizeFencedCode(text: string): Array<{ code: boolean; value: string }> {
  const tokens: Array<{ code: boolean; value: string }> = [];
  const pattern = /```[\s\S]*?```/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ code: false, value: text.slice(cursor, index) });
    }
    tokens.push({ code: true, value: match[0] });
    cursor = index + match[0].length;
  }

  if (cursor < text.length) {
    tokens.push({ code: false, value: text.slice(cursor) });
  }

  return tokens;
}

/**
 * Split a model reply into chat-sized bubbles.
 *
 * Natural paragraph boundaries become separate messages. Long prose is split at
 * sentence/punctuation boundaries. Fenced code blocks stay intact so technical
 * replies remain readable; channel-specific hard limits are applied afterwards.
 */
export function splitHumanMessages(text: string, maxLength = DEFAULT_MAX_BUBBLE_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (!Number.isInteger(maxLength) || maxLength < 80) {
    throw new Error("maxLength must be an integer >= 80.");
  }

  const parts: string[] = [];
  for (const token of tokenizeFencedCode(trimmed)) {
    const value = token.value.trim();
    if (!value) continue;
    if (token.code) {
      parts.push(value);
    } else {
      parts.push(...splitProse(value, maxLength));
    }
  }

  return capBubbleCount(parts.filter(Boolean));
}
