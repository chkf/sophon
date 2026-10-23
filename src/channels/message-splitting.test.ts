import assert from "node:assert/strict";
import test from "node:test";
import { splitHumanMessages } from "./message-splitting.js";

test("short paragraphs become separate chat bubbles", () => {
  assert.deepEqual(
    splitHumanMessages("第一条很短。\n\n第二条也很短。"),
    ["第一条很短。", "第二条也很短。"],
  );
});

test("long prose is split near sentence boundaries", () => {
  const text = [
    "第一句稍微长一点，用来测试较长回复的自然切分。",
    "第二句继续补充一些内容，但不应该单独被硬切在奇怪的位置。",
    "第三句继续说明，让整段文字明显超过一个聊天气泡。",
    "第四句再补一点内容，确保最终确实会被拆成多个部分。",
  ].join("");
  const parts = splitHumanMessages(text, 80);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 80));
  assert.equal(parts.join(" ").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});

test("fenced code blocks stay together", () => {
  const code = "```ts\nconst answer = 42;\nconsole.log(answer);\n```";
  const parts = splitHumanMessages("先看这个：\n\n" + code + "\n\n然后继续。", 80);
  assert.deepEqual(parts, ["先看这个：", code, "然后继续。"]);
});

test("empty reply produces no bubbles", () => {
  assert.deepEqual(splitHumanMessages("   \n  "), []);
});


test("very long replies are capped at ten bubbles without dropping content", () => {
  const paragraphs = Array.from({ length: 23 }, (_, index) => `第${index + 1}段。`);
  const text = paragraphs.join("\n\n");
  const parts = splitHumanMessages(text, 80);

  assert.equal(parts.length, 10);
  assert.equal(parts.join("\n\n").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});
