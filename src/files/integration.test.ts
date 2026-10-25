import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeGateway } from "../setup.js";
import { SessionStore } from "../sessions/store.js";
import { LocalCoreContextProvider } from "../core/context.js";
import { Gateway } from "../gateway.js";
import { FileService } from "./service.js";
import { TelegramAdapter } from "../channels/telegram/adapter.js";
import { TelegramBotApi } from "../channels/telegram/api.js";
import { MediaStore } from "../media/store.js";
import type { ChatRequest } from "../runtime/types.js";

test("Gateway advertises and executes file tools through the owner Telegram transport", async t => {
  const root = await mkdtemp(join(tmpdir(), "sophon-file-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "state");
  await initializeGateway(data);
  let sent = 0;
  const telegram = new TelegramAdapter({ dataDir: data, ownerId: "70001", token: "70001:synthetic",
    mediaStore: new MediaStore(join(root, "media")), api: {
      async call(method, body) {
        assert.equal(method, "sendDocument"); assert.equal(body.chat_id, "70001");
        const file = body.document as File;
        assert.equal(file.name, "result.csv"); assert.equal(await file.text(), "label,value\nA,1\n");
        sent++; return { message_id: 51 } as any;
      }, async getFile() { throw new Error("Unused fixture method"); }, async downloadFile() { throw new Error("Unused fixture method"); },
    } });
  const files = new FileService(data, join(root, "generated"), "70001", file => telegram.sendDocumentToOwner(file));
  const sessions = new SessionStore(data);
  t.after(() => sessions.close());
  const runtime = { async reply(request: ChatRequest) {
    assert.ok(request.tools?.some(tool => tool.name === "gateway_file_list"));
    const result = await request.executeTool!("telegram_send_document", { mode: "generate", filename: "result.csv", content: "label,value\nA,1\n" }) as any;
    assert.equal(result.messageId, 51);
    assert.equal(await readFile(result.path, "utf8"), "label,value\nA,1\n");
    return { text: "文档已生成并发送。" };
  } };
  const gateway = new Gateway(runtime, sessions, new LocalCoreContextProvider(data), 10, "UTC", undefined, undefined, undefined, undefined, undefined, undefined, files);
  const result = await gateway.handle({ channel: "telegram", senderId: "70001", conversationId: "70001", messageId: "fixture-1",
    receivedAt: "2030-01-02T09:00:00Z", text: "请生成 CSV 文件", attachments: [] });
  assert.equal(result.kind, "model_reply");
  assert.equal(sent, 1);
});

test("multipart document uploads preserve the supplied filename", async t => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const form = init.body as FormData;
    const file = form.get("document") as File;
    assert.equal(file.name, "测试文档.csv"); assert.equal(await file.text(), "a,b\n1,2");
    assert.equal(form.get("chat_id"), "70001");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 21 } }));
  });
  const api = new TelegramBotApi("70001:synthetic");
  assert.deepEqual(await api.call("sendDocument", { chat_id: "70001", document: new File(["a,b\n1,2"], "测试文档.csv") }), { message_id: 21 });
});
