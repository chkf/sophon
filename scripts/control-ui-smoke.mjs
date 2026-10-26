/** Optional browser acceptance with isolated synthetic responses; never contacts a model or real channel. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.SOPHON_UI_PLAYWRIGHT_MODULE || 'playwright').catch(() => {
  throw new Error('Install Playwright locally for this optional check: npm install --no-save --package-lock=false playwright');
});
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.SOPHON_UI_QA_OUTPUT || join(tmpdir(), 'sophon-control-ui');
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  const assets = { '/control/': ['index.html', 'text/html'], '/control/app.js': ['app.js', 'text/javascript'], '/control/app.css': ['app.css', 'text/css'] };
  const asset = assets[req.url];
  if (!asset) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('content-type', asset[1]); res.end(await readFile(join(root, 'src/control/assets', asset[0])));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const at = '2026-01-15T10:00:00.000Z';
const neutral = '<img src=x onerror="window.fixtureInjected=true">';
const steps = [
  { id: 'condition', kind: 'condition', name: '条件检查', status: 'completed', startedAt: at, finishedAt: '2026-01-15T10:00:00.020Z', durationMs: 20, output: { eligible: true } },
  { id: 'model', kind: 'model', name: '模型调用', status: 'completed', startedAt: at, finishedAt: '2026-01-15T10:00:02.000Z', durationMs: 2000, provider: 'api', model: 'fixture-model', input: { task: '检查文档进度' }, output: { tool: 'read_history' }, usage: { inputTokens: 300, outputTokens: 20 } },
  { id: 'tool', parentId: 'model', kind: 'tool', name: '读取历史', status: 'completed', startedAt: '2026-01-15T10:00:02.000Z', finishedAt: '2026-01-15T10:00:02.050Z', durationMs: 50, input: { query: '文档' }, output: neutral },
  { id: 'delivery', kind: 'delivery', name: '消息交付', status: 'completed', startedAt: '2026-01-15T10:00:02.050Z', finishedAt: '2026-01-15T10:00:02.100Z', durationMs: 50, output: { acknowledged: true } },
];
const runs = [
  { id: 'run-delivered', kind: 'heartbeat_decision', trigger: 'planned_wake', startedAt: at, finishedAt: '2026-01-15T10:00:02.100Z', durationMs: 2100, status: 'delivered', stepCount: steps.length, modelStepCount: 1, usageReportedModelSteps: 1, usageCompleteFields: ['inputTokens', 'outputTokens'], usage: { inputTokens: 300, outputTokens: 20 }, steps },
  { id: 'run-silent', kind: 'heartbeat_decision', trigger: 'planned_wake', startedAt: '2026-01-15T09:00:00.000Z', finishedAt: '2026-01-15T09:00:02.000Z', durationMs: 2000, status: 'silent', stepCount: 1, steps: [{ ...steps[1], output: 'SILENT' }] },
  { id: 'run-unknown', kind: 'heartbeat_delivery', trigger: 'pending_delivery', startedAt: '2026-01-15T08:00:00.000Z', durationMs: 1500, status: 'delivery_unknown', reason: '没有交付确认', stepCount: 1, steps: [{ ...steps[3], status: 'failed', error: '网络连接中断' }] },
];
const olderRuns = Array.from({ length: 31 }, (_, index) => ({ ...runs[1], id: `older-${index}`, startedAt: new Date(Date.parse(at) - (index + 10) * 3600000).toISOString() }));
let showNewRun = false;
let authenticated = false, conflict = false, saves = 0, searches = 0, around = 0, archived = false;
let core = { body: '# Core\n按实际证据回答任务。', revision: 1, updatedAt: at };
let recent = { id: 'topic-one', body: '# 文档整理\n下次检查目录。', revision: 1, updatedAt: at, archived: false, conversationState: 'Ongoing', stateDate: null, eventAt: null };
const browser = await chromium.launch({ headless: true, ...(process.env.SOPHON_UI_BROWSER_PATH ? { executablePath: process.env.SOPHON_UI_BROWSER_PATH } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, colorScheme: 'dark' });
  await page.clock.install();
  const checkLayout = async name => {
    await page.screenshot({ path: join(output, `${name}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 320, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} overflows at 320px`);
    await page.screenshot({ path: join(output, `${name}-mobile.png`), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 1000 });
  };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
  await page.route(`${origin}/control/api/**`, async route => {
    const req = route.request(), action = req.url().split('/').at(-1), body = req.postDataJSON() || {};
    assert.equal(req.method(), 'POST');
    const respond = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 400 ? { ok: true, data } : { ok: false, error: data }) });
    if (action === 'session') return respond({ authenticated, ...(authenticated ? { csrfToken: 'fixture-csrf' } : {}) });
    if (action === 'login') { assert.equal(body.code, 'fixture-code'); authenticated = true; return respond({ authenticated: true, csrfToken: 'fixture-csrf' }); }
    assert.equal(req.headers()['x-control-csrf'], 'fixture-csrf');
    if (action === 'logout') { authenticated = false; return respond({ authenticated: false }); }
    if (action === 'tasks') return respond({ runs: (body.before ? olderRuns : showNewRun ? [{ ...runs[1], id: 'new-run', startedAt: '2026-01-15T11:00:00.000Z' }, ...runs] : runs).map(({ steps, ...summary }) => summary), nextBefore: body.before ? null : 'older-cursor', heartbeat: { enabled: true, timezone: 'UTC', attemptsToday: 2, activeChannel: 'telegram', plan: { date: '2026-01-15', generatedAt: at, wakes: [{ time: '18:00', intent: '检查文档整理进度', consumed: false }] } } });
    if (action === 'task') return respond([...runs, ...olderRuns].find(run => run.id === body.id));
    if (action === 'conversations') return respond({ items: [{ key: 'fixture-conversation', channel: 'telegram', conversationId: 'fixture-owner', count: 2, updatedAt: at }], total: 1, nextOffset: null });
    if (action === 'history') { if (body.query) searches++; if (body.around !== undefined) around++; return respond({ conversationKey: body.conversationKey, items: [{ index: 0, role: 'user', content: `请检查文档。${neutral}`, at, channel: 'telegram', attachments: [] }, { index: 1, role: 'assistant', content: '目录已整理。', at, channel: 'telegram', attachments: [{ index: 0, kind: 'file', fileName: 'notes.txt', mimeType: 'application/octet-stream' }] }], total: 2, nextOffset: null, offset: 0, filtered: Boolean(body.query && body.around === undefined) }); }
    if (action === 'attachment') { assert.equal(body.messageIndex, 1); return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'synthetic attachment' }); }
    if (action === 'core') return respond(core);
    if (action === 'core-save') { assert.equal(body.expectedRevision, core.revision); if (conflict) return respond({ code: 'revision_conflict', message: 'Core 已被更新。' }, 409); core = { ...core, body: body.body, revision: core.revision + 1 }; saves++; return respond(core); }
    if (action === 'recent') return respond({ items: recent && (body.archived === undefined || body.archived === recent.archived) ? [recent] : [], total: recent ? 1 : 0, nextOffset: null });
    if (action === 'recent-save') { assert.equal(body.expectedRevision, recent.revision); recent = { ...recent, body: body.body, revision: recent.revision + 1 }; saves++; return respond(recent); }
    if (action === 'recent-archive') { assert.equal(body.expectedRevision, recent.revision); recent = { ...recent, archived: body.archived, revision: recent.revision + 1 }; archived = true; return respond(recent); }
    if (action === 'recent-delete') { assert.equal(body.expectedRevision, recent.revision); recent = null; return respond({ deleted: [body.id] }); }
    if (action === 'context') return respond({ available: true, loadedAt: at, local: { core: core.body, recentDirectory: '文档整理', guidance: '依据真实内容执行。', expression: { showStageDirections: false, instruction: '心理和动作描写已关闭。' }, revisions: { core: 'core-r1', recent: 'recent-r1', expression: 'expression-r1' } }, recent: { activeCount: 1, totalCount: 1 }, checkpoints: [{ id: 'fixture-checkpoint', model: 'fixture-model', updatedAt: at, lastCompactedAt: at, historyCursor: 12, coverageVerified: true, pendingDelivery: false, archived: false, checkpoint: null }], lastRequest: { at, startedAt: at, durationMs: 2000, provider: 'api', model: 'fixture-model', status: 'completed', usage: { inputTokens: 120, cachedInputTokens: 60, outputTokens: 20 }, contextEffect: 'none', compaction: null, scope: 'last_model_call' }, usage: { supported: true, note: '仅展示最近一次实际调用的用量。' }, note: '最近一次组装的本地内容，不代表完整模型上下文。' });
    if (action === 'host') return respond({ supported: true, at, samples: Array.from({ length: 20 }, (_, i) => ({ at: new Date(Date.parse(at) + i * 5000).toISOString(), cpuPercent: i ? 5 + i * 2 : null, memoryUsedBytes: 400_000_000 + i * 2_000_000, memoryTotalBytes: 1_000_000_000, swapUsedBytes: 0, swapTotalBytes: 0, diskUsedBytes: 5_000_000_000, diskTotalBytes: 25_000_000_000, rxBytesPerSecond: i ? i * 1024 : null, txBytesPerSecond: i ? i * 500 : null })), uptimeSeconds: 86400, processUptimeSeconds: 800, rssBytes: 80_000_000, networkInterfaces: ['fixture0'], scopeNotes: ['接口采样不代表账单流量。'] });
    throw new Error('Unmocked action: ' + action);
  });
  await page.goto(origin + '/control/');
  await page.locator('#login-code').fill('fixture-code');
  await page.locator('#login-form button').click();
  await page.locator('.run-button').first().waitFor();
  assert.equal(await page.locator('.run-button').first().getAttribute('aria-pressed'), 'true');
  await page.locator('details[data-step-id="tool"] summary').click();
  assert.match(await page.locator('details[data-step-id="tool"] pre').last().innerText(), /onerror/);
  assert.equal(await page.evaluate(() => window.fixtureInjected), undefined);
  assert.equal(await page.locator('#task-detail img').count(), 0);
  assert.doesNotMatch(await page.locator('#task-detail').innerText(), /nullnull|undefined/);
  await page.screenshot({ path: join(output, 'tasks-desktop-dark.png'), fullPage: true });
  await page.locator('.run-button').nth(1).click();
  await page.getByText('本次模型选择保持静默，未创建发送任务。').waitFor();
  await page.locator('.run-button').nth(2).click();
  await page.getByText('没有交付确认', { exact: true }).waitFor();
  await page.locator('.run-button').first().click();
  await page.locator('details[data-step-id="tool"] summary').click();
  for (const width of [1024, 736, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    const overflow = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(overflow.document <= overflow.width, `task overflow at ${width}: ${JSON.stringify(overflow)}`);
    if (width === 390) await page.screenshot({ path: join(output, 'tasks-mobile-dark.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: join(output, 'tasks-desktop-light.png'), fullPage: true });
  await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await page.locator('.run-button').nth(33).waitFor();
  assert.equal(await page.locator('details[data-step-id="tool"]').getAttribute('open'), '');
  showNewRun = true; await page.clock.fastForward(10_001);
  await page.locator('.run-button').nth(34).waitFor();
  assert.equal(await page.locator('.run-button[aria-pressed="true"]').count(), 1);
  assert.match(await page.locator('#task-detail .record-id').innerText(), /run-delivered/);
  assert.equal(await page.locator('details[data-step-id="tool"]').getAttribute('open'), '');
  await page.locator('[data-page="history"]').click();
  await page.locator('input[name="query"]').waitFor(); await checkLayout('history');
  await page.locator('input[name="query"]').fill('文档'); await page.locator('.filter-form button').click();
  await page.getByRole('button', { name: '查看前后文', exact: true }).first().click();
  await page.getByText('匹配消息的前后文', { exact: true }).waitFor(); assert.equal(searches, 1); assert.equal(around, 1);
  assert.equal(await page.locator('.message-content img').count(), 0);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: /notes.txt/ }).click(); await download;
  await page.locator('[data-page="memory"]').click();
  await page.getByLabel('Core 正文').waitFor(); await checkLayout('core');
  await page.getByLabel('Core 正文').fill('# Core\n按实际证据回答任务。\n保留必要上下文。');
  await page.getByRole('button', { name: '查看差异', exact: true }).click(); assert.match(await page.locator('.diff-lines').innerText(), /保留必要上下文/);
  await page.getByRole('button', { name: '保存修改', exact: true }).click(); await page.getByText('修改已保存。', { exact: true }).waitFor(); assert.equal(saves, 1);
  conflict = true; await page.getByLabel('Core 正文').fill('# Core\n冲突时保留草稿。'); await page.getByRole('button', { name: '保存修改', exact: true }).click(); await page.locator('.conflict-note:not([hidden])').waitFor(); assert.match(await page.getByLabel('Core 正文').inputValue(), /保留草稿/);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '重新读取', exact: true }).click(); conflict = false;
  await page.getByRole('tab', { name: 'Recent', exact: true }).click(); await page.getByLabel('Recent 正文').fill('# 文档整理\n已核对目录。'); await page.getByRole('button', { name: '保存修改', exact: true }).click(); await page.getByText('修改已保存。', { exact: true }).waitFor(); assert.equal(saves, 2);
  await page.getByRole('button', { name: '归档', exact: true }).click(); await page.getByText('话题已归档。', { exact: true }).waitFor(); assert.equal(archived, true);
  await page.getByLabel('话题状态').selectOption('true'); await page.getByRole('button', { name: '删除', exact: true }).waitFor(); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '删除', exact: true }).click(); await page.getByText('Recent 已删除。', { exact: true }).waitFor(); assert.equal(recent, null);
  await page.locator('[data-page="context"]').click(); await page.getByRole('heading', { name: '恢复检查点', exact: true }).waitFor(); await page.getByRole('heading', { name: '最近一次模型调用', exact: true }).waitFor(); await checkLayout('context');
  await page.locator('[data-page="host"]').click(); await page.getByText('主机与进程', { exact: true }).waitFor(); assert.equal(await page.locator('.metric-chart').count(), 3); await checkLayout('host');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.locator('#refresh').click(); await page.getByText('主机与进程', { exact: true }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); assert.equal(overflow, false, `host overflow at ${width}`);
  }
  await page.locator('#logout').click(); await page.locator('#login:not([hidden])').waitFor(); assert.equal(authenticated, false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['login', 'csrf', 'trace expansion', 'SILENT', 'uncertain delivery', 'XSS text', 'history search and context', 'attachment download', 'Core diff and save', 'revision conflict draft', 'Recent save/archive/delete', 'context projection', 'poll preserves older pages/selection/expanded steps', 'host charts', '320px layout', 'light/dark', 'logout'], screenshots: output }));
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
