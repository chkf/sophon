import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeGateway } from "../setup.js";
import { ControlCenter } from "./server.js";
import { ControlData } from "./data.js";
import { HostMonitor } from "./host.js";
import { TaskTraceStore } from "../observability/store.js";

async function fixture(run: (client: {
  control: ControlCenter; origin: string; data: ControlData; dataDir: string; server: Server;
  post: (action: string, input?: unknown, headers?: Record<string, string>) => Promise<Response>;
}) => Promise<void>, beforeMutation?: () => Promise<void>, temporary = false): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sophon-control-http-")), dataDir = join(root, "data");
  await initializeGateway(dataDir);
  let control: ControlCenter;
  const server = createServer(async (req, res) => { if (!(await control.handle(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number }, origin = "http://127.0.0.1:" + address.port;
  const traces = new TaskTraceStore(dataDir);
  const data = new ControlData(dataDir);
  control = new ControlCenter({ publicUrl: temporary ? "https://pending.trycloudflare.com/control/" : origin + "/control/", temporary, data, traces,
    host: new HostMonitor(dataDir), heartbeat: async () => ({ enabled: false, timezone: "UTC" }),
    mutate: async work => { await beforeMutation?.(); return work(); } });
  const post = (action: string, input: unknown = {}, headers: Record<string, string> = {}) => fetch(origin + "/control/api/" + action,
    { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
  try { await run({ control, origin, data, dataDir, post, server }); }
  finally { await control.close(); traces.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}

test("control HTTP protects data with owner code, exact Origin, CSRF and logout", () => fixture(async ({ control, origin, post }) => {
  assert.equal((await post("core")).status, 401);
  const code = control.auth.issueCode();
  assert.equal((await post("login", { code }, { origin: "https://different.example" })).status, 403);
  const login = await post("login", { code });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0], csrf = (await login.json()).data.csrfToken;
  assert.equal((await post("login", { code })).status, 401);
  assert.equal((await post("core", {}, { cookie })).status, 403);
  const headers = { cookie, "x-control-csrf": csrf };
  const current = await post("core", {}, headers);
  assert.equal(current.status, 200);
  assert.ok((await current.json()).data.body);
  const session = await post("session", {}, { cookie });
  assert.equal((await session.json()).data.csrfToken, csrf);
  const host = await post("host", {}, headers);
  assert.ok(Array.isArray((await host.json()).data.samples));
  for (const action of ["provider", "model", "update", "restart", "logs", "test", "proactive"]) {
    assert.equal((await post(action, {}, headers)).status, 404, action + " should remain outside the control API");
  }
  const staticPage = await fetch(origin + "/control/");
  assert.equal(staticPage.status, 200);
  assert.match(staticPage.headers.get("content-security-policy")!, /script-src 'self'/);
  assert.equal(staticPage.headers.get("cache-control"), "no-store");
  assert.equal((await post("logout", {}, headers)).status, 200);
  assert.equal((await post("core", {}, headers)).status, 401);
}));

test("control rejects cross-site credentials, unexpected hosts, malformed and oversized JSON", () => fixture(async ({ control, origin, post }) => {
  const code = control.auth.issueCode();
  assert.equal((await post("login", { code }, { "sec-fetch-site": "cross-site" })).status, 403);
  const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(origin + "/control/api/login", { method: "POST", headers: { host: "different.example", origin, "content-type": "application/json" } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    req.once("error", reject); req.end(JSON.stringify({ code }));
  });
  assert.equal(rejectedHost, 403);
  assert.equal((await post("login", { code }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post("login", [])).status, 400);
  assert.equal((await post("login", { code, excess: "x".repeat(400 * 1024) })).status, 413);
  const get = await fetch(origin + "/control/api/core");
  assert.equal(get.status, 405);
  assert.equal((await post("login", { code })).status, 200);
}));

test("Core writes keep revision conflicts and do not add forbidden operational routes", () => fixture(async ({ control, post }) => {
  const login = await post("login", { code: control.auth.issueCode() });
  const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0], "x-control-csrf": (await login.json()).data.csrfToken };
  const core = (await (await post("core", {}, headers)).json()).data;
  const save = await post("core-save", { body: "# Assistant\nProvide concise document summaries.", expectedRevision: core.revision }, headers);
  assert.equal(save.status, 200);
  const stale = await post("core-save", { body: "A stale replacement.", expectedRevision: core.revision }, headers);
  assert.equal(stale.status, 409);
  const after = (await (await post("core", {}, headers)).json()).data;
  assert.equal(after.body, "# Assistant\nProvide concise document summaries.");
  const invalid = await post("attachment", { path: "/etc/passwd" }, headers);
  assert.equal(invalid.status, 400);
  const tasks = (await (await post("tasks", {}, headers)).json()).data;
  assert.deepEqual(tasks.runs, []);
  assert.equal(tasks.heartbeat.enabled, false);
  assert.equal((await post("tasks", { limit: 1000 }, headers)).status, 400);
  assert.equal((await post("tasks", { before: "invalid-cursor" }, headers)).status, 400);
}));

function mutationGate() {
  let release!: () => void, enter!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  return { entered, release, block: () => { enter(); return waiting; } };
}

test("shutdown rejects a queued write and waits for its response before closing data", async () => {
  const gate = mutationGate();
  await fixture(async ({ control, post, data, dataDir }) => {
    try {
      const login = await post("login", { code: control.auth.issueCode() });
      const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0], "x-control-csrf": (await login.json()).data.csrfToken };
      const original = (await (await post("core", {}, headers)).json()).data;
      const queued = post("core-save", { body: "# Assistant\nSummarize the new document.", expectedRevision: original.revision }, headers);
      await gate.entered;

      let closed = false;
      const closing = control.close().then(() => { closed = true; });
      const refused = await post("core", {}, headers);
      assert.equal(refused.status, 503);
      assert.equal((await refused.json()).error.code, "shutting_down");
      assert.equal(closed, false, "shutdown must wait for the queued HTTP request");
      assert.doesNotThrow(() => data.conversations(), "the data connection stays open while requests drain");

      gate.release();
      const response = await queued;
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "shutting_down");
      await closing;
      assert.equal(closed, true);
      assert.throws(() => data.conversations(), "the data connection closes after draining");
      const reopened = new ControlData(dataDir);
      try { assert.deepEqual(await reopened.core(), original, "shutdown must not execute the pending write"); }
      finally { reopened.close(); }
    } finally { gate.release(); }
  }, gate.block);
});

test("a queued write rechecks authentication after the owner logs out", async () => {
  const gate = mutationGate();
  await fixture(async ({ control, post }) => {
    try {
      const login = await post("login", { code: control.auth.issueCode() });
      const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0], "x-control-csrf": (await login.json()).data.csrfToken };
      const original = (await (await post("core", {}, headers)).json()).data;
      const queued = post("core-save", { body: "# Assistant\nReview the next document.", expectedRevision: original.revision }, headers);
      await gate.entered;
      assert.equal((await post("logout", {}, headers)).status, 200);

      gate.release();
      const response = await queued;
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "authentication_required");
      const nextLogin = await post("login", { code: control.auth.issueCode() });
      const nextHeaders = { cookie: nextLogin.headers.get("set-cookie")!.split(";")[0], "x-control-csrf": (await nextLogin.json()).data.csrfToken };
      const current = (await (await post("core", {}, nextHeaders)).json()).data;
      assert.deepEqual(current, original, "revoked sessions must not perform queued writes");
    } finally { gate.release(); }
  }, gate.block);
});

test("a disconnected browser cannot apply its still-queued edit later", async () => {
  const gate = mutationGate();
  await fixture(async ({ control, origin, post, data, server }) => {
    try {
      const login = await post("login", { code: control.auth.issueCode() });
      const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0], "x-control-csrf": (await login.json()).data.csrfToken };
      const original = await data.core();
      const closed = new Promise<void>(resolve => server.once("request", (_req, res) => res.once("close", resolve)));
      const controller = new AbortController();
      const pending = fetch(origin + "/control/api/core-save", { method: "POST", signal: controller.signal,
        headers: { origin, "content-type": "application/json", ...headers },
        body: JSON.stringify({ body: "# Assistant\nAn abandoned edit.", expectedRevision: original.revision }) }).catch(error => error);
      await gate.entered;
      controller.abort(); await pending; await closed;
      gate.release();
      // Allow the released promise chain to settle without shutting down/revoking the session.
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(await data.core(), original);
      assert.equal((await post("core", {}, headers)).status, 200, "the owner session is still valid");
    } finally { gate.release(); }
  }, gate.block);
});

test("automatic login fragment is one-use and a newer entry invalidates an old code",()=>fixture(async({control,post})=>{
  const old=new URL(control.loginEntry().url),entry=control.loginEntry(),url=new URL(entry.url);
  assert.equal(url.search,'');assert.match(url.hash,/^#login_code=/);
  const code=new URLSearchParams(url.hash.slice(1)).get('login_code');
  assert.equal((await post('login',{code:new URLSearchParams(old.hash.slice(1)).get('login_code')})).status,401);
  assert.equal((await post('login',{code})).status,200);
  assert.equal((await post('login',{code})).status,401);
}));

test("fixed address ignores tunnel changes", async () => {
  await fixture(async ({ control, post, origin }) => {
    // Existing fixed-address behavior must not accept unsolicited tunnel IPC.
    control.setTunnelUrl("https://neutral-example.trycloudflare.com/control/");
    assert.ok(control.loginEntry().url.startsWith(origin));
    assert.equal((await post("session")).status, 200);
  });
});


test("temporary URL changes revoke sessions and codes and enforce the new Host and Origin", () => fixture(async ({control,origin,post}) => {
  assert.match(control.loginMessage(), /尚未就绪/);
  assert.throws(() => control.loginEntry(), /unavailable/);
  control.setTunnelUrl("https://first-example.trycloudflare.com/control/");
  const oldCode = control.auth.issueCode(), session = control.auth.create();
  control.setTunnelUrl("https://next-example.trycloudflare.com/control/");
  assert.equal(control.auth.consumeCode(oldCode), false);
  assert.equal(control.auth.get(session.id), undefined);
  assert.ok(control.loginEntry().url.startsWith("https://next-example.trycloudflare.com/control/"));
  assert.equal((await post("session")).status, 403);
  const send = (requestOrigin: string) => new Promise<number>((resolve,reject) => {
    const req = request(origin + "/control/api/session", {method:"POST", headers:{host:"next-example.trycloudflare.com",origin:requestOrigin,"content-type":"application/json"}}, res => {res.resume();res.on("end",()=>resolve(res.statusCode!));});
    req.on("error",reject);req.end("{}");
  });
  assert.equal(await send("https://next-example.trycloudflare.com"), 200);
  assert.equal(await send("https://first-example.trycloudflare.com"), 403);
  control.setTunnelUrl(null, "download_failed");
  assert.match(control.loginMessage(), /尚未就绪/);
  assert.match(control.loginMessage(), /组件下载失败/);
  control.setTunnelUrl(null, "synthetic-internal-detail");
  assert.doesNotMatch(control.loginMessage(), /synthetic-internal-detail/);
  assert.equal((await post("session")).status, 503);
}, undefined, true));

test('graph prompt writes require owner session and CSRF and enforce revision conflicts',()=>fixture(async({control,post})=>{
 assert.equal((await post('graph-prompt-save',{id:'digest',expectedRevision:0,content:'合成提示词'})).status,401);
 const login=await post('login',{code:control.auth.issueCode()});const cookie=login.headers.get('set-cookie')!.split(';')[0];
 const csrf=(await login.json()).data.csrfToken;
 assert.equal((await post('graph-prompt-save',{id:'digest',expectedRevision:0,content:'合成提示词'},{cookie})).status,403);
 const headers={cookie,'x-control-csrf':csrf};const read=await post('graph-prompts',{},headers);assert.equal(read.status,200);
 const revision=(await read.json()).data.revision;
 assert.equal((await post('graph-prompt-save',{id:'digest',expectedRevision:revision,content:'输出带引用的合成摘要。'},headers)).status,200);
 assert.equal((await post('graph-prompt-save',{id:'digest',expectedRevision:revision,reset:true},headers)).status,409);
 assert.equal((await post('graph-prompt-save',{id:'digest',expectedRevision:revision+1,reset:true},headers)).status,200);
}));
