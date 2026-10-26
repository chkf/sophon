(() => {
  'use strict';
  // Fragments never enter HTTP requests. Remove the credential before any await.
  const entryParams = new URLSearchParams(window.location.hash.slice(1));
  let entryCode = entryParams.get('login_code') || '';
  if (entryParams.has('login_code')) history.replaceState(null, '', location.pathname + location.search);
  if (!/^[A-Za-z0-9_-]{43}$/.test(entryCode)) entryCode = '';
  const $ = selector => document.querySelector(selector);
  const content = $('#page-content');
  let hostResize;
  const state = { authenticated: false, csrf: '', page: 'tasks', epoch: 0, dirty: false, saving: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    task: { runs: [], nextBefore: null, selected: null, open: new Set(), filter: 'all', heartbeat: null },
    history: { conversations: [], nextConversations: null, key: '', query: '', from: '', to: '', offset: 0, around: null },
    graph: { topic: null, topicOffset: 0, offset: 0, query: "", status: "active", selected: null },
    memory: { tab: 'core', selected: null, entries: [], nextOffset: null, query: '', archived: false }, pollBusy: false };
  const pages = { graph: ["记忆图", "按主题浏览记忆与原始记录。"], tasks: ['主动任务', '从触发到交付，查看每一步真实执行。'], history: ['聊天历史', '最新消息在前，翻阅对话、搜索原文与关联附件。'], memory: ['Core / Recent', '管理稳定指令与持续话题。'], context: ['上下文', '查看本地上下文的组成与可恢复检查点。'], host: ['主机监控', '资源走势与当前进程，来自真实采样。'] };
  const statusNames = { running: '运行中', completed: '已完成', silent: '保持静默', skipped: '已跳过', failed: '失败', delivered: '确认送达', delivery_unknown: '交付不确定', interrupted: '已中断', acknowledged: '已确认', started: '进行中', pending: '待处理', unknown: '未知' };
  const taskNames = { heartbeat_plan: 'Heartbeat · 计划生成', heartbeat_decision: 'Heartbeat · 主动判断', heartbeat_delivery: 'Heartbeat · 消息交付', heartbeat_check: 'Heartbeat · 条件检查' };
  const triggerNames = { scheduler_gate: '调度条件检查', pending_delivery: '待交付消息', context_changed: '上下文变化', daily_plan: '每日计划', planned_wake: '计划唤醒', scheduled_check: '定时检查' };
  const reasonNames = {
    'quiet-hours': '处于免打扰时段', quiet_hours: '处于免打扰时段', cooldown: '处于冷却时间', 'daily-cap': '达到当天尝试上限', daily_cap: '达到当天尝试上限',
    'daily-cap-disabled': '每日尝试上限为零', background_disabled: '当前 Provider 未启用后台调用', SILENT: '模型返回 SILENT', model_returned_silent: '模型返回 SILENT，保持静默',
    planning_window_closed: '尚未到每日计划生成时段', planning_debounce: '最近有新消息，等待对话稳定后重新规划', planning_throttle: '近期已尝试规划，等待下一次机会',
    channel_unavailable: '当前主动消息渠道不可用', core_unavailable: '本地 Core 不可用', paused: '主动任务已暂停', policy_blocked: '未满足执行条件',
    model_request_failed: '模型请求失败', pending_expired: '待发送消息已过期', pending_channel_missing: '待发送消息缺少渠道', channel_changed: '主动消息渠道已变化',
    partial_delivery: '仅部分内容已确认送达', empty_delivery: '没有可交付内容', partial_voice_delivery: '文字已送达，语音交付失败或不确定', delivery_failed_or_uncertain: '交付失败或结果不确定',
    planning_failed: '计划生成失败', empty_plan: '本次没有安排新的唤醒机会', plan_persistence_failed: '计划保存失败', empty_output: '模型未返回可发送内容',
    duplicate_output: '与近期主动消息重复，已跳过', task_failed: '任务执行失败', process_interrupted: '进程结束前任务尚未完成',
  };
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
  const date = (value, options = {}) => {
    if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
    return new Intl.DateTimeFormat('zh-CN', { timeZone: state.timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, ...options }).format(new Date(value));
  };
  const day = value => date(value, { year: 'numeric', month: '2-digit', day: '2-digit', hour: undefined, minute: undefined });
  const time = value => date(value, { month: undefined, day: undefined, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const duration = value => typeof value !== 'number' || !Number.isFinite(value) ? '—' : value < 1000 ? `${Math.max(0, Math.round(value))} ms` : value < 60_000 ? `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s` : `${(value / 60_000).toFixed(1)} min`;
  const bytes = value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    if (value < 1024) return `${Math.round(value)} B`;
    if (value < 1048576) return `${(value / 1024).toFixed(1)} KiB`;
    if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MiB`;
    return `${(value / 1073741824).toFixed(2)} GiB`;
  };
  const uptime = seconds => typeof seconds !== 'number' ? '—' : `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`;
  function el(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined || value === null || (value === false && !key.startsWith('aria-'))) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'value') node.value = value;
      else if (key === 'checked') node.checked = value;
      else if (key === 'disabled' || key === 'hidden') node[key] = value;
      else node.setAttribute(key, value === true && !key.startsWith('aria-') ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  }
  function replace(node, ...children) { node.replaceChildren(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)); }
  function button(label, action, className = '', attributes = {}) {
    return el('button', { type: 'button', class: `button ${className}`, ...attributes, onclick: event => {
      try { Promise.resolve(action(event)).catch(showError); } catch (error) { showError(error); }
    } }, label);
  }
  function showNotice(message, type = '') { const node = $('#notice'); node.textContent = message; node.className = `notice ${type}`; node.hidden = !message; }
  function showError(error) { if (error?.name === 'AbortError') return; showNotice(error?.message || '操作失败，请稍后重试。', 'error'); }
  function updated() { $('#updated-at').textContent = `更新于 ${time(new Date().toISOString())} · ${state.timezone}`; }
  function empty(title, description, symbol = '◌') { return el('div', { class: 'empty-state' }, el('div', { class: 'empty-mark', 'aria-hidden': 'true' }, symbol), el('h3', {}, title), el('p', {}, description)); }
  function loading(label = '正在读取数据') { return el('div', { class: 'loading', role: 'status' }, label); }
  function status(value) { return el('span', { class: `status ${value || 'unknown'}` }, statusNames[value] || value || '未知'); }
  function fact(label, value, note) { return el('div', { class: 'fact' }, el('span', { class: 'fact-label' }, label), el('span', { class: 'fact-value' }, value, note ? el('small', {}, note) : null)); }
  function kv(entries) { return el('dl', { class: 'key-values' }, entries.flatMap(([key, value]) => [el('dt', {}, key), el('dd', {}, value ?? '—')])); }
  function stringify(value) { if (value === undefined || value === null) return '未记录'; return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  async function api(action, body = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let response;
    try { response = await fetch(`/control/api/${action}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', ...(state.csrf ? { 'x-control-csrf': state.csrf } : {}) }, body: JSON.stringify(body), signal: controller.signal }); }
    catch (error) { if (error.name === 'AbortError') throw new Error('请求超时，请稍后重试。'); throw new Error('无法连接控制中心，请检查连接后重试。'); }
    finally { clearTimeout(timeout); }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      if (response.status === 401 && action !== 'login' && action !== 'session') setAuthenticated(false);
      const error = new Error(payload?.error?.message || `请求失败（${response.status}）`);
      error.code = payload?.error?.code; error.status = response.status; throw error;
    }
    return payload.data;
  }
  function setAuthenticated(authenticated, csrfToken = '') {
    state.authenticated = authenticated; state.csrf = csrfToken;
    $('#login').hidden = authenticated; $('#workspace').hidden = !authenticated; $('#header-actions').hidden = !authenticated;
    $('#navigation').querySelectorAll('button').forEach(node => { node.disabled = !authenticated; });
    if (!authenticated) { state.epoch++; state.dirty = false; state.task.runs = []; state.task.selected = null; state.history.conversations = []; state.memory.entries = []; state.graph.selected = null; content.replaceChildren(); }
  }
  window.addEventListener('hashchange', () => {
    if (!new URLSearchParams(location.hash.slice(1)).has('login_code')) return;
    if (state.authenticated) history.replaceState(null, '', location.pathname + location.search);
    else location.reload(); // Reopening a link in the same tab also runs login bootstrap.
  });
  function canLeave() { if (state.saving) { showNotice('修改正在保存，请稍候。'); return false; } if (!state.dirty) return true; return window.confirm('有尚未保存的修改，离开后会丢弃这些修改。继续吗？'); }
  async function navigate(page, force = false) {
    if (!state.authenticated || (!force && !canLeave())) return;
    state.dirty = false; state.page = pages[page] ? page : 'tasks'; state.epoch++; hostResize?.disconnect();
    const [title, description] = pages[state.page];
    $('#page-title').textContent = title; $('#page-name').textContent = title; $('#page-description').textContent = description;
    $('#navigation').querySelectorAll('button').forEach(node => { if (node.dataset.page === state.page) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
    showNotice(''); content.replaceChildren(loading());
    const epoch = state.epoch;
    try {
      if (state.page === 'tasks') await loadTasks(false, epoch);
      else if (state.page === 'history') await historyPage(epoch);
      else if (state.page === 'memory') await memoryPage(epoch);
      else if (state.page === 'graph') await graphPage(epoch);
      else if (state.page === 'context') await contextPage(epoch);
      else await hostPage(epoch);
      if (epoch === state.epoch) updated();
    } catch (error) {
      if (epoch !== state.epoch || !state.authenticated) return;
      content.replaceChildren(el('div', { class: 'panel' }, empty('数据暂时无法读取', error.message), el('div', { class: 'list-more' }, button('重新读取', () => navigate(state.page, true))))); showError(error);
    }
  }
  async function loadTasks(append, epoch = state.epoch) {
    const result = await api('tasks', { limit: 30, ...(append && state.task.nextBefore ? { before: state.task.nextBefore } : {}) });
    if (epoch !== state.epoch) return;
    state.task.runs = append ? [...state.task.runs, ...result.runs.filter(run => !state.task.runs.some(existing => existing.id === run.id))] : result.runs;
    state.task.nextBefore = result.nextBefore; state.task.heartbeat = result.heartbeat;
    if (result.heartbeat?.timezone) state.timezone = result.heartbeat.timezone;
    if (!state.task.selected && result.runs.length) state.task.selected = result.runs[0].id;
    renderTasks();
    if (state.task.selected) await loadTaskDetail(state.task.selected, epoch);
  }
  function taskToolbar() {
    const hb = state.task.heartbeat;
    return el('div', { class: 'toolbar', id: 'task-toolbar' }, el('div', { class: 'task-state' },
      el('span', { class: 'task-state-label' }, el('span', { class: 'live-dot' }), el('strong', {}, hb?.enabled ? 'Heartbeat 已启用' : 'Heartbeat 未启用')),
      hb ? el('span', {}, '当天发送尝试 ', el('strong', {}, number(hb.attemptsToday))) : null,
      hb?.nextCheckAt ? el('span', {}, '下次检查 ', el('strong', {}, date(hb.nextCheckAt))) : null), el('span', { class: 'small' }, state.timezone));
  }
  function taskPlan(open = false) {
    const plan = state.task.heartbeat?.plan; if (!plan) return null;
    return el('details', { class: 'panel plan-panel', id: 'task-plan', open }, el('summary', {}, `当前唤醒计划 · ${plan.date || ''} · ${(plan.wakes || []).length} 个机会`),
      el('div', { class: 'plan-content' }, el('div', { class: 'plan-wakes' }, ...(plan.wakes || []).map(wake => el('div', { class: `plan-wake ${wake.consumed ? 'consumed' : ''}` }, el('strong', {}, wake.time, el('span', { class: 'muted small' }, wake.consumed ? '已使用' : '待检查')), el('p', {}, wake.intent)))), el('p', { class: 'plan-note' }, `生成于 ${date(plan.generatedAt)}。计划代表检查机会，届时仍可能静默。`)));
  }
  function renderTasks() {
    const filter = el('select', { 'aria-label': '按执行结果筛选', onchange: event => { state.task.filter = event.target.value; renderTaskList(); } },
      ...[['all', '全部结果'], ['delivered', '确认送达'], ['silent', '静默 / 跳过'], ['failed', '失败 / 不确定'], ['running', '运行中']].map(([value, label]) => el('option', { value }, label)));
    filter.value = state.task.filter;
    const runPanel = el('section', { class: 'run-list-panel', 'aria-label': '执行记录' }, el('div', { class: 'section-heading' }, el('h3', {}, '执行记录'), filter), el('div', { id: 'task-runs', class: 'run-items' }), el('div', { id: 'task-more', class: 'list-more' }));
    const inspector = el('section', { id: 'task-detail', class: 'inspector', 'aria-label': '调用轨迹' }, empty('选择一次执行', '左侧每条记录对应一次真实任务。'));
    const nodes = [taskToolbar(), el('div', { id: 'task-plan-slot' }, taskPlan())];
    nodes.push(el('div', { class: 'panel workbench' }, runPanel, inspector));
    content.replaceChildren(...nodes); renderTaskList();
  }
  function renderTaskList() {
    const list = $('#task-runs'); if (!list) return;
    const matches = run => state.task.filter === 'all' || (state.task.filter === 'silent' ? ['silent', 'skipped'].includes(run.status) : state.task.filter === 'failed' ? ['failed', 'delivery_unknown', 'interrupted'].includes(run.status) : run.status === state.task.filter);
    const runs = state.task.runs.filter(matches);
    if (!runs.length) list.replaceChildren(empty(state.task.runs.length ? '没有匹配的执行' : '还没有执行记录', state.task.runs.length ? '可以切换筛选或加载更早记录。' : '启用记录后的主动任务会出现在这里，已有历史不会被猜测补全。'));
    else {
      let lastDay;
      list.replaceChildren(...runs.flatMap(run => {
        const currentDay = day(run.startedAt), nodes = [];
        if (currentDay !== lastDay) { nodes.push(el('div', { class: 'run-day' }, currentDay)); lastDay = currentDay; }
        nodes.push(el('button', { type: 'button', class: 'run-button', 'aria-pressed': run.id === state.task.selected, onclick: () => {
          state.task.selected = run.id; state.task.open.clear(); renderTaskList(); loadTaskDetail(run.id).catch(showError);
        } }, el('span', { class: 'run-button-top' }, el('span', { class: 'run-time' }, time(run.startedAt)), status(run.status)), el('span', { class: 'run-title' }, taskNames[run.kind] || run.kind), el('span', { class: 'run-meta' }, `${number(run.stepCount)} 个步骤 · ${duration(run.durationMs)}`)));
        return nodes;
      }));
    }
    $('#task-more').replaceChildren(...(state.task.nextBefore ? [button('加载更早记录', () => loadTasks(true), 'small')] : []));
  }
  async function loadTaskDetail(id, epoch = state.epoch, quiet = false) {
    const target = $('#task-detail'); if (!target) return;
    if (!quiet) replace(target, loading('正在读取调用轨迹'));
    const run = await api('task', { id });
    if (epoch !== state.epoch || id !== state.task.selected || !$('#task-detail')) return;
    if (!run) { replace(target, empty('记录已不可用', '这条执行记录可能已超过保留范围。')); return; }
    const steps = Array.isArray(run.steps) ? run.steps : [];
    const models = run.modelStepCount ?? steps.filter(step => step.kind === 'model').length, tools = steps.filter(step => step.kind === 'tool').length;
    const usage = run.usage;
    const partialUsage = typeof run.usageReportedModelSteps === 'number' && run.usageReportedModelSteps < models;
    const partialInput = usage?.inputTokens !== undefined && Array.isArray(run.usageCompleteFields) && !run.usageCompleteFields.includes('inputTokens');
    const total = Math.max(typeof run.durationMs === 'number' ? run.durationMs : 0, ...steps.map(step => Math.max(0, new Date(step.finishedAt || step.startedAt).getTime() - new Date(run.startedAt).getTime())).filter(Number.isFinite), 1);
    const timeline = el('div', { class: 'trace-steps' });
    for (const step of steps) {
      const opened = state.task.open.has(step.id);
      const detail = el('details', { class: `trace-step ${step.kind}`, open: opened, 'data-step-id': step.id });
      const spanStart = Math.max(0, Math.min(100, (new Date(step.startedAt).getTime() - new Date(run.startedAt).getTime()) / total * 100));
      const spanWidth = Math.max(.3, Math.min(100 - spanStart, (step.durationMs || 0) / total * 100));
      const bar = el('span', { class: 'waterfall-bar' }); bar.style.left = `${Number.isFinite(spanStart) ? spanStart : 0}%`; bar.style.width = `${Number.isFinite(spanWidth) ? spanWidth : .3}%`;
      const metadata = [step.provider, step.model].filter(Boolean).join(' · ');
      const stepContent = el('div', { class: 'step-content' });
      if (step.input !== undefined) stepContent.append(el('div', { class: 'detail-section' }, el('div', { class: 'detail-label' }, step.kind === 'tool' ? '输入 / 参数' : '输入'), el('pre', {}, stringify(step.input))));
      if (step.output !== undefined) stepContent.append(el('div', { class: 'detail-section' }, el('div', { class: 'detail-label' }, '输出 / 结果'), el('pre', {}, stringify(step.output))));
      if (step.error !== undefined) stepContent.append(el('div', { class: 'detail-section error' }, el('div', { class: 'detail-label' }, '错误'), el('pre', {}, stringify(step.error))));
      if (step.input === undefined && step.output === undefined && step.error === undefined) stepContent.append(el('p', { class: 'small muted' }, '此步骤未记录输入或输出。'));
      if (step.usage) stepContent.append(usageRow(step.usage));
      if (step.truncated) stepContent.append(el('p', { class: 'trace-note' }, '该步骤内容超出记录上限，已截断。'));
      if (step.parentId) { const parent = steps.find(item => item.id === step.parentId); if (parent) stepContent.prepend(el('p', { class: 'trace-note' }, `关联调用：${parent.name}`)); }
      detail.append(el('summary', {}, el('span', { class: 'trace-node', 'aria-hidden': 'true' }), el('span', { class: 'step-line' }, el('span', { class: 'step-name' }, step.name), el('span', { class: 'step-time' }, duration(step.durationMs)), el('span', { class: 'step-chevron', 'aria-hidden': 'true' }, '›')), el('span', { class: 'step-meta' }, metadata ? el('span', {}, metadata) : null, status(step.status)), el('div', { class: 'waterfall-track', 'aria-hidden': 'true' }, bar)), stepContent);
      detail.addEventListener('toggle', () => { if (detail.open) state.task.open.add(step.id); else state.task.open.delete(step.id); });
      timeline.append(detail);
    }
    const reason = reasonNames[run.reason] || run.reason;
    const descriptions = { delivered: '交付已收到明确确认。', silent: '本次模型选择保持静默，未创建发送任务。', skipped: '本次在条件检查或策略判断后结束。', failed: '本次执行失败，可展开步骤查看已记录的错误。', delivery_unknown: '发送已尝试，但没有可靠的送达确认。', interrupted: '执行未正常结束，保留已记录的步骤。', running: '任务尚在执行，后续步骤会随记录刷新。', completed: '本次任务已完成。' };
    replace(target, el('div', { class: 'run-heading' }, el('h2', {}, taskNames[run.kind] || run.kind), status(run.status)), el('p', { class: 'record-id' }, run.id), el('p', { class: 'run-trigger' }, `触发：${triggerNames[run.trigger] || run.trigger || '未记录'}${run.channel ? ` · ${run.channel === 'wechat' ? '微信' : run.channel === 'telegram' ? 'Telegram' : run.channel}` : ''}`),
      el('div', { class: 'facts' }, fact('开始时间', time(run.startedAt)), fact('总耗时', duration(run.durationMs)), fact('调用次数', `${models} / ${tools}`, '模型 / 工具'), fact('输入 token', number(usage?.inputTokens), partialInput ? '部分回报' : undefined)),
      el('div', { class: 'trace-head' }, el('h3', {}, '调用轨迹'), el('div', { class: 'trace-legend' }, ...[['model', '模型'], ['tool', '工具'], ['system', '系统']].map(([kind, label]) => el('span', {}, el('i', { class: kind, 'aria-hidden': 'true' }), label)))),
      steps.length ? el('div', { class: 'trace-scale' }, el('span', {}, '0'), el('span', {}, duration(total))) : null,
      steps.length ? timeline : empty('尚无步骤', '运行开始后，实际步骤会逐条记录。'),
      el('div', { class: `outcome ${run.status}` }, el('span', { class: 'outcome-mark', 'aria-hidden': 'true' }, run.status === 'delivered' ? '✓' : run.status === 'failed' || run.status === 'delivery_unknown' ? '!' : '·'), el('div', {}, el('strong', {}, statusNames[run.status] || run.status), el('p', {}, reason || descriptions[run.status] || '查看上方已记录的执行步骤。'), run.reason ? el('p', { class: 'trace-note' }, `原因代码：${run.reason}`) : null)),
      usage ? usageRow(usage, run.usageCompleteFields) : null, partialUsage ? el('p', { class: 'trace-note' }, `${run.usageReportedModelSteps} / ${models} 次模型尝试回报了用量，以上为已回报部分。`) : null, run.truncated || run.droppedSteps ? el('p', { class: 'trace-note' }, `记录达到存储上限，部分内容已截断${run.droppedSteps ? `，另有 ${number(run.droppedSteps)} 个步骤未保留` : ''}。`) : null, el('p', { class: 'trace-note' }, '用量仅展示 Provider 实际回报；空缺表示未知。输入 token 为各次调用累计，包含缓存输入。'));
  }
  function usageRow(usage, completeFields) {
    const partial = key => Array.isArray(completeFields) && typeof usage[key] === 'number' && !completeFields.includes(key) ? '（部分回报）' : '';
    return el('div', { class: 'usage-row' }, el('span', {}, `输入 ${number(usage.inputTokens)}${partial('inputTokens')}`), el('span', {}, `缓存 ${number(usage.cachedInputTokens)}${partial('cachedInputTokens')}`), el('span', {}, `输出 ${number(usage.outputTokens)}${partial('outputTokens')}`), typeof usage.reasoningTokens === 'number' ? el('span', {}, `推理 token ${number(usage.reasoningTokens)}${partial('reasoningTokens')}`) : null, typeof usage.costUsd === 'number' ? el('span', {}, `费用 $${usage.costUsd.toFixed(6)}${partial('costUsd')}`) : null);
  }
  async function historyPage(epoch) {
    const result = await api('conversations', { limit: 50 });
    if (epoch !== state.epoch) return;
    state.history.conversations = result.items; state.history.nextConversations = result.nextOffset;
    if (!result.items.some(item => item.key === state.history.key)) state.history.key = result.items[0]?.key || '';
    if (!state.history.key) { content.replaceChildren(el('div', { class: 'panel' }, empty('还没有聊天历史', '正式对话写入后，可以在这里按日期浏览和搜索。'))); return; }
    renderHistoryShell(); await loadHistory(epoch);
  }
  function renderHistoryShell() {
    const hs = state.history;
    const picker = el('select', { class: 'conversation-picker', 'aria-label': '选择会话', onchange: event => { hs.key = event.target.value; hs.offset = 0; hs.around = null; loadHistory().catch(showError); } }, ...hs.conversations.map((item, index) => el('option', { value: item.key }, `${item.channel === 'wechat' ? '微信' : 'Telegram'} · 会话 ${index + 1} · ${number(item.count)} 条 · ${date(item.updatedAt)}`)));
    picker.value = hs.key;
    const query = el('input', { type: 'search', maxlength: '256', value: hs.query, placeholder: '搜索对话原文', name: 'query' });
    const from = el('input', { type: 'date', value: hs.from, name: 'from' }), to = el('input', { type: 'date', value: hs.to, name: 'to' });
    const form = el('form', { class: 'filter-form', onsubmit: event => {
      event.preventDefault(); hs.query = query.value.trim(); hs.from = from.value; hs.to = to.value; hs.offset = 0; hs.around = null; loadHistory().catch(showError);
    } }, el('label', { class: 'grow' }, '关键词', query), el('label', {}, '起始日期', from), el('label', {}, '结束日期', to), el('button', { type: 'submit', class: 'button primary' }, '查询'));
    const more = hs.nextConversations === null || hs.nextConversations === undefined ? null : button('加载更多会话', async () => {
      const result = await api('conversations', { offset: hs.nextConversations, limit: 50 }); hs.conversations.push(...result.items); hs.nextConversations = result.nextOffset; renderHistoryShell(); await loadHistory();
    }, 'small subtle');
    content.replaceChildren(el('div', { class: 'panel' }, el('div', { class: 'history-toolbar' }, picker, more, form), el('div', { id: 'history-results' }, loading())));
  }
  function historyPosition(deletedRevision) {
    const anchor = [...document.querySelectorAll('#history-results .message')].find(node =>
      node.dataset.messageRevision !== deletedRevision && node.getBoundingClientRect().bottom > 0);
    return { revision: anchor?.dataset.messageRevision, top: anchor?.getBoundingClientRect().top, y: window.scrollY };
  }
  function restoreHistoryPosition(position) {
    if (!position) return;
    const anchor = [...document.querySelectorAll('#history-results .message')].find(node => node.dataset.messageRevision === position.revision);
    window.scrollTo({ top: anchor ? window.scrollY + anchor.getBoundingClientRect().top - position.top : position.y, behavior: 'instant' });
  }
  async function loadHistory(epoch = state.epoch, position = null) {
    const hs = state.history, target = $('#history-results'); if (!target) return;
    const sequence = hs.sequence = (hs.sequence || 0) + 1;
    const request = { conversationKey: hs.key, limit: 40, ...(hs.around !== null ? { around: hs.around, expectedRevision: hs.aroundRevision } : { offset: hs.offset, ...(hs.query ? { query: hs.query } : {}), ...(hs.from ? { from: hs.from } : {}), ...(hs.to ? { to: hs.to } : {}) }) };
    if (!position) replace(target, loading());
    let result = await api('history', request);
    if (epoch !== state.epoch || sequence !== hs.sequence || hs.key !== request.conversationKey || !$('#history-results')) return;
    // Deleting the final row of the last page may make its offset invalid.
    if (request.around === undefined && request.offset > 0 && !result.items?.length) {
      hs.offset = request.offset = Math.max(0, Math.floor((result.total - 1) / request.limit) * request.limit);
      result = await api('history', request);
    }
    if (epoch !== state.epoch || sequence !== hs.sequence || hs.key !== request.conversationKey || !$('#history-results')) return;
    const contextMode = hs.around !== null;
    const top = el('div', { class: 'history-meta' }, el('span', {}, contextMode ? '匹配消息的前后文 · 最新在前' : `${result.filtered ? '匹配' : '共'} ${number(result.total)} 条消息`), contextMode ? button('返回查询结果', () => { hs.around = null; return loadHistory(); }, 'small subtle') : el('span', {}, `最新在前 · 日期按 ${state.timezone}`));
    const messages = el('div', { class: 'messages' });
    for (const message of result.items || []) {
      const attachments = (message.attachments || []).map(attachment => {
        const group = el('div', { class: 'attachment-item' });
        const safeImage = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.mimeType);
        group.append(button(`${safeImage ? '▧' : '▤'} ${attachment.fileName || '附件'}`, async () => {
          if (!safeImage) return downloadAttachment(hs.key, message.index, attachment);
          const existing = group.querySelector('img');
          if (existing) { existing.hidden = !existing.hidden; return; }
          const blob = await fetchAttachment(hs.key, message.index, attachment), url = URL.createObjectURL(new Blob([blob], { type: attachment.mimeType }));
          const image = el('img', { class: 'attachment-preview', src: url, alt: attachment.fileName || '历史消息图片', onload: () => URL.revokeObjectURL(url), onerror: () => { URL.revokeObjectURL(url); image.remove(); showNotice('图片无法预览，可尝试下载附件。', 'error'); } });
          group.append(image);
        }, 'small attachment-button'));
        if (safeImage) group.append(button('下载', () => downloadAttachment(hs.key, message.index, attachment), 'small subtle'));
        return group;
      });
      messages.append(el('article', { class: `message ${message.role}`, 'data-message-index': message.index, 'data-message-revision': message.revision }, el('div', { class: 'message-avatar', 'aria-hidden': 'true' }, message.role === 'assistant' ? 'S' : 'U'), el('div', {},
        el('div', { class: 'message-top' }, el('strong', {}, message.role === 'assistant' ? 'Sophon' : '用户'), el('span', {}, date(message.at, { second: '2-digit' })), el('span', {}, message.channel === 'wechat' ? '微信' : 'Telegram'), message.origin === 'proactive' ? el('span', { class: 'message-label' }, '主动消息') : null, message.partial ? el('span', { class: 'message-label' }, '部分交付') : null),
        el('div', { class: 'message-content' }, message.content), attachments.length ? el('div', { class: 'attachment-list' }, attachments) : null,
        el('div', { class: 'message-context' }, button('删除记录', async () => {
          if (state.saving || sequence !== hs.sequence) return;
          if (!window.confirm('删除这条本地聊天记录？\n\n' + message.content.slice(0, 160) + '\n\n这条记录会从聊天数据库中删除，不留占位；保留现有压缩上下文，等下次重建时更新近期记录，不立即重建或重新压缩。不会撤回 Telegram／微信消息，也不会清理 Recent、附件文件或备份。此操作不能在页面内撤销。')) return;
          const conversationKey = hs.key, position = historyPosition(message.revision);
          state.saving = true;
          try {
            await api('history-delete', { conversationKey, messageIndex: message.index, expectedRevision: message.revision, confirm: true });
            if (epoch !== state.epoch || state.page !== 'history' || hs.key !== conversationKey) return;
            showNotice('本地记录已删除。', 'success');
            if (sequence !== hs.sequence) return; // A newer search or page owns the view.
            if (contextMode) {
              // SQLite closes the deleted index gap; retain the context target,
              // or choose its nearest surviving neighbour when that target was deleted.
              const remaining = result.items.filter(item => item.index !== message.index);
              const anchor = remaining.find(item => item.index === hs.around) ||
                remaining.sort((a, b) => Math.abs(a.index - hs.around) - Math.abs(b.index - hs.around))[0];
              hs.around = anchor ? anchor.index - (anchor.index > message.index ? 1 : 0) : null;
              hs.aroundRevision = anchor?.revision;
            }
            const conversation = hs.conversations.find(item => item.key === conversationKey);
            if (conversation) {
              conversation.count = Math.max(0, conversation.count - 1);
              const index = hs.conversations.indexOf(conversation);
              const option = $('.conversation-picker')?.options[index];
              if (option) option.textContent = `${conversation.channel === 'wechat' ? '微信' : 'Telegram'} · 会话 ${index + 1} · ${number(conversation.count)} 条 · ${date(conversation.updatedAt)}`;
            }
            await loadHistory(epoch, position);
          } finally { state.saving = false; }
        }, 'small danger')),
        result.filtered ? el('div', { class: 'message-context' }, button('查看前后文', () => { hs.around = message.index; hs.aroundRevision = message.revision; return loadHistory(); }, 'small subtle')) : null)));
    }
    if (!result.items?.length) messages.append(empty('没有匹配的消息', '试试其他关键词或日期范围。'));
    const offset = result.offset ?? hs.offset;
    const pager = contextMode ? null : el('div', { class: 'pager' }, button('较新消息', () => { hs.offset = Math.max(0, offset - 40); return loadHistory(); }, '', { disabled: offset <= 0 }), el('span', {}, result.items?.length ? `${offset + 1}–${offset + result.items.length} / ${number(result.total)}` : '0 条'), button('更早消息', () => { hs.offset = result.nextOffset; return loadHistory(); }, '', { disabled: result.nextOffset === null || result.nextOffset === undefined }));
    replace(target, top, messages, ...(pager ? [pager] : [])); updated();
    restoreHistoryPosition(position);
  }
  async function fetchAttachment(conversationKey, messageIndex, attachment) {
    const response = await fetch('/control/api/attachment', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-control-csrf': state.csrf }, body: JSON.stringify({ conversationKey, messageIndex, attachmentIndex: attachment.index, expectedRevision: attachment.expectedRevision }) });
    if (!response.ok) { const payload = await response.json().catch(() => null); if (response.status === 401) setAuthenticated(false); throw new Error(payload?.error?.message || '附件无法读取。'); }
    return response.blob();
  }
  async function downloadAttachment(conversationKey, messageIndex, attachment) {
    const blob = await fetchAttachment(conversationKey, messageIndex, attachment), url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: (attachment.fileName || 'attachment').replace(/[\\/]/g, '_') });
    link.hidden = true; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  async function memoryPage(epoch) {
    const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': '上下文内容' }, ...[['core', 'Core'], ['recent', 'Recent']].map(([id, label]) => el('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': state.memory.tab === id, onclick: () => {
      if (!canLeave()) return; state.dirty = false; state.memory.tab = id; memoryPage(state.epoch).catch(showError);
    } }, label)));
    content.replaceChildren(tabs, el('div', { id: 'memory-content' }, loading()));
    if (state.memory.tab === 'core') {
      const snapshot = await api('core'); if (epoch !== state.epoch || state.memory.tab !== 'core') return;
      $('#memory-content').replaceChildren(el('div', { class: 'panel panel-pad editor' }, makeEditor(snapshot, 'core')));
    } else await loadRecent(false, epoch);
  }
  function makeEditor(snapshot, kind) {
    const wrapper = el('div'), isCore = kind === 'core';
    let baseline = { ...snapshot }, saving = false;
    const editor = el('textarea', { value: baseline.body, spellcheck: 'false', 'aria-label': isCore ? 'Core 正文' : 'Recent 正文' });
    const meta = el('span'), conflict = el('div', { class: 'conflict-note', hidden: true });
    const diff = el('div', { hidden: true }), updatedLabel = el('span');
    const title = isCore ? 'Core' : firstLine(baseline.body);
    const heading = el('div', { class: 'editor-header' }, el('div', {}, el('h3', {}, title), el('p', {}, isCore ? '稳定指令与偏好' : baseline.archived ? '已归档话题' : '活跃话题')));
    const saveButton = button('保存修改', async () => {
      if (saving || editor.value === baseline.body) return;
      saving = true; state.saving = true; saveButton.disabled = true; conflict.hidden = true;
      try {
        const next = await api(isCore ? 'core-save' : 'recent-save', { ...(isCore ? {} : { id: baseline.id }), body: editor.value, expectedRevision: baseline.revision });
        baseline = { ...next }; editor.value = next.body; state.dirty = false; diff.hidden = true; updateMeta(); showNotice('修改已保存。', 'success');
        if (!isCore) { const index = state.memory.entries.findIndex(entry => entry.id === next.id); if (index >= 0) state.memory.entries[index] = next; renderRecentList(); }
      } catch (error) {
        if (error.status === 409 || error.code === 'revision_conflict') {
          conflict.replaceChildren(el('span', {}, '内容已在别处更新。当前草稿保留，请重新读取后合并。'), button('重新读取', async () => {
            if (!window.confirm('重新读取会丢弃当前草稿，继续吗？')) return;
            state.dirty = false; await memoryPage(state.epoch);
          }, 'small')); conflict.hidden = false;
        }
        throw error;
      } finally { saving = false; state.saving = false; saveButton.disabled = editor.value === baseline.body; }
    }, 'primary', { disabled: true });
    const diffButton = button('查看差异', () => { diff.hidden = !diff.hidden; if (!diff.hidden) renderDiff(diff, baseline.body, editor.value); }, '');
    const actions = el('div', { class: 'editor-actions' }, diffButton, saveButton);
    if (!isCore) {
      actions.append(button(baseline.archived ? '恢复话题' : '归档', async () => {
        if (!canLeave()) return;
        await api('recent-archive', { id: baseline.id, expectedRevision: baseline.revision, archived: !baseline.archived }); state.dirty = false; state.memory.selected = null; await loadRecent(false); showNotice(baseline.archived ? '话题已恢复。' : '话题已归档。', 'success');
      }, 'subtle'), button('删除', async () => {
        if (!window.confirm('删除这条 Recent？原始聊天记录会保留。')) return;
        await api('recent-delete', { id: baseline.id, expectedRevision: baseline.revision }); state.dirty = false; state.memory.selected = null; await loadRecent(false); showNotice('Recent 已删除。', 'success');
      }, 'danger'));
    }
    heading.append(actions);
    function updateMeta() { meta.replaceChildren(...(editor.value !== baseline.body ? [el('span', { class: 'dirty-dot' }), '未保存 · '] : []), `${number(editor.value.length)} 字符`); updatedLabel.textContent = `修订 ${baseline.revision} · ${date(baseline.updatedAt)}`; saveButton.disabled = saving || editor.value === baseline.body; }
    editor.addEventListener('input', () => { state.dirty = editor.value !== baseline.body; updateMeta(); if (!diff.hidden) renderDiff(diff, baseline.body, editor.value); });
    wrapper.append(heading, conflict, editor, el('div', { class: 'editor-meta' }, meta, updatedLabel), diff); updateMeta(); return wrapper;
  }
  function renderDiff(target, before, after) {
    const oldLines = before.split('\n'), newLines = after.split('\n'); let prefix = 0, suffix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
    while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
    const removed = oldLines.slice(prefix, oldLines.length - suffix), added = newLines.slice(prefix, newLines.length - suffix);
    const lines = el('div', { class: 'diff-lines' });
    if (!removed.length && !added.length) lines.append(el('div', { class: 'diff-line' }, '没有修改。'));
    else {
      if (prefix) lines.append(el('div', { class: 'diff-line muted' }, `… 前 ${prefix} 行未变`));
      removed.forEach(line => lines.append(el('span', { class: 'diff-line removed' }, `− ${line}`)));
      added.forEach(line => lines.append(el('span', { class: 'diff-line added' }, `+ ${line}`)));
      if (suffix) lines.append(el('div', { class: 'diff-line muted' }, `… 后 ${suffix} 行未变`));
    }
    replace(target, el('div', { class: 'diff-view' }, el('div', { class: 'diff-title' }, el('span', {}, '修改差异'), el('span', {}, `−${removed.length} / +${added.length} 行`)), lines));
  }
  function firstLine(body) { return String(body || '').split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').slice(0, 60) || '未命名话题'; }
  async function loadRecent(append, epoch = state.epoch) {
    const ms = state.memory; const sequence = ms.sequence = (ms.sequence || 0) + 1;
    const result = await api('recent', { limit: 40, ...(append && ms.nextOffset !== null ? { offset: ms.nextOffset } : {}), ...(ms.query ? { query: ms.query } : {}), ...(ms.archived === 'all' ? {} : { archived: ms.archived }) });
    if (epoch !== state.epoch || sequence !== ms.sequence || ms.tab !== 'recent') return;
    ms.entries = append ? [...ms.entries, ...result.items] : result.items; ms.nextOffset = result.nextOffset;
    if (!ms.entries.some(item => item.id === ms.selected)) ms.selected = ms.entries[0]?.id || null;
    const search = el('input', { type: 'search', value: ms.query, maxlength: '256', placeholder: '搜索话题正文', 'aria-label': '搜索 Recent' });
    const archived = el('select', { 'aria-label': '话题状态' }, el('option', { value: 'false' }, '活跃话题'), el('option', { value: 'true' }, '已归档'), el('option', { value: 'all' }, '全部话题'));
    archived.value = String(ms.archived);
    const applyFilter = async () => { if (!canLeave()) return; state.dirty = false; ms.query = search.value.trim(); ms.archived = archived.value === 'all' ? 'all' : archived.value === 'true'; ms.selected = null; await loadRecent(false); };
    search.addEventListener('search', () => applyFilter().catch(showError)); search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); applyFilter().catch(showError); } }); archived.addEventListener('change', () => applyFilter().catch(showError));
    const list = el('section', { class: 'recent-list', 'aria-label': 'Recent 话题列表' }, el('div', { class: 'recent-filter' }, search, archived), el('div', { id: 'recent-items', class: 'recent-items' }), result.nextOffset !== null ? el('div', { class: 'list-more' }, button('加载更多', () => { if (!canLeave()) return; state.dirty = false; return loadRecent(true); }, 'small')) : null);
    $('#memory-content').replaceChildren(el('div', { class: 'panel memory-grid' }, list, el('section', { class: 'editor', id: 'recent-editor', 'aria-label': '编辑话题' })));
    renderRecentList(); renderRecentEditor();
  }
  function renderRecentList() {
    const list = $('#recent-items'); if (!list) return;
    if (!state.memory.entries.length) { list.replaceChildren(empty('没有话题', '当前筛选下没有 Recent。')); return; }
    list.replaceChildren(...state.memory.entries.map(entry => el('button', { type: 'button', class: 'recent-item', 'aria-pressed': entry.id === state.memory.selected, onclick: () => {
      if (!canLeave()) return; state.dirty = false; state.memory.selected = entry.id; renderRecentList(); renderRecentEditor();
    } }, el('strong', {}, firstLine(entry.body)), el('span', {}, `${entry.archived ? '已归档' : '活跃'} · ${date(entry.updatedAt)}`))));
  }
  function renderRecentEditor() { const entry = state.memory.entries.find(item => item.id === state.memory.selected); $('#recent-editor')?.replaceChildren(entry ? makeEditor(entry, 'recent') : empty('选择一个话题', '从左侧打开 Recent，查看或编辑正文。')); }
  const graphKind = { turn: '对话记忆', rollup: '融合记忆', recent: '持续事项' };
  const graphStatus = { active: '活跃', archived: '已归档', stale: '来源已变化', covered: '已融合覆盖' };
  const activity = value => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
  async function graphPage(epoch) {
    const result = await api('graph'); if (epoch !== state.epoch) return;
    if (!result.available) {
      content.replaceChildren(el('div', { class: 'panel' }, empty('记忆图尚未准备好', result.version ? '需要完成记忆图升级并配置所有者，之后即可浏览。' : '完成首次迁移后，主题和记忆会显示在这里。'))); return;
    }
    content.replaceChildren(el('div', { id: 'graph-overview' }), el('div', { class: 'panel graph-workbench' },
      el('section', { id: 'graph-topics', class: 'graph-topics', 'aria-label': '主题目录' }, loading()),
      el('section', { class: 'graph-memories', 'aria-label': '主题记忆' }, el('div', { id: 'graph-filters' }), el('div', { id: 'graph-nodes' }, loading()))),
      el('section', { id: 'graph-detail', class: 'panel panel-pad graph-detail', 'aria-label': '记忆详情' }, empty('选择一条记忆', '查看内容、主题关联和原文来源。')));
    renderGraphOverview(result);
    const gs = state.graph;
    const query = el('input', { type: 'search', maxlength: '500', value: gs.query, placeholder: '搜索全图记忆', 'aria-label': '搜索记忆图' });
    const filter = el('select', { 'aria-label': '记忆状态' }, el('option', { value: 'active' }, '活跃记忆'), el('option', { value: 'archived' }, '已归档 / 已融合'), el('option', { value: 'stale' }, '来源已变化'));
    filter.value = gs.status; filter.disabled = Boolean(gs.query);
    const apply = () => { gs.query = query.value.trim(); gs.offset = 0; gs.selected = null; filter.disabled = Boolean(gs.query); loadGraphNodes(epoch).catch(showError); };
    query.addEventListener('search', apply);
    filter.addEventListener('change', () => { gs.status = filter.value; gs.offset = 0; gs.selected = null; loadGraphNodes(epoch).catch(showError); });
    $('#graph-filters').append(el('form', { class: 'filter-form', onsubmit: event => { event.preventDefault(); apply(); } },
      el('label', { class: 'grow' }, '全图搜索', query), el('label', {}, '浏览状态', filter), el('button', { type: 'submit', class: 'button' }, '搜索')));
    await Promise.all([loadGraphTopics(epoch), loadGraphNodes(epoch)]);
    if (gs.selected) await loadGraphNode(gs.selected, 0, epoch);
  }
  function renderGraphOverview(result) {
    const target = $('#graph-overview'); if (!target) return;
    const p = result.progress, jobs = p.jobs, pending = (jobs.pending || 0) + (jobs.running || 0) + (jobs.retry || 0);
    const outstanding = pending + (jobs.failed || 0) + p.missingTurns + p.staleTurns;
    const summary = !result.enabled ? '后台状态 · 未启用' : !p.initialized ? '后台状态 · 待初始建图' : outstanding ? `后台状态 · ${number(outstanding)} 项待处理` : '后台状态';
    const details = el('details', { class: 'panel graph-background', open: target.querySelector('details')?.open === true }, el('summary', {}, summary),
      el('p', { class: 'muted small' }, result.enabled ? (p.ready ? '初始分类已就绪，整理任务仍可继续运行。' : '后台逐轮处理，正常聊天优先。入队不代表建图完成。') : '后台处理未启用，已保存的记忆仍可浏览。'),
      kv([['已处理分类', number(jobs.done || 0)], ['待处理 / 运行中', `${number(jobs.pending || 0)} / ${number(jobs.running || 0)}`],
        ['重试 / 失败', `${number(jobs.retry || 0)} / ${number(jobs.failed || 0)}`], ['待回灌 / 失效轮次', `${number(p.missingTurns)} / ${number(p.staleTurns)}`],
        ['初始建图登记', p.initialized ? date(p.startedAt) : '尚未登记'], ['上下文重建就绪', p.ready ? '是' : '否']]),
      el('p', { class: 'muted small' }, '整理任务：' + (Object.entries(p.operations).map(([key, value]) => `${statusNames[key] || key} ${number(value)}`).join(' · ') || '暂无')),
      ...(result.problems || []).map(item => el('p', { class: 'graph-problem' }, `${statusNames[item.status] || item.status} · ${item.error_code || '未知原因'} · 尝试 ${item.attempts} 次 · ${date(item.updated_at)}`)),
      button('刷新后台状态', async () => { const epoch = state.epoch, next = await api('graph'); if (epoch === state.epoch && next.available) renderGraphOverview(next); }, 'small subtle'));
    target.replaceChildren(el('div', { class: 'graph-summary' }, fact('主题', number(result.topics)), fact('活跃记忆', number(result.counts.active || 0)),
      fact('来源已变化', number(result.counts.stale || 0)), el('p', { class: 'muted small' }, '活跃度随时间变化，不代表事实可信度。原始聊天仍可查阅。')), details);
  }
  async function chooseGraphTopic(id) {
    const gs = state.graph; gs.topic = id; gs.topicOffset = 0; gs.offset = 0; gs.query = ''; gs.selected = null;
    const search = $('#graph-filters input'); if (search) search.value = '';
    const select = $('#graph-filters select'); if (select) select.disabled = false;
    await Promise.all([loadGraphTopics(), loadGraphNodes()]);
  }
  async function loadGraphTopics(epoch = state.epoch) {
    const gs = state.graph, sequence = gs.topicSequence = (gs.topicSequence || 0) + 1;
    const result = await api('graph-topics', { parentId: gs.topic, offset: gs.topicOffset, limit: 20 });
    if (epoch !== state.epoch || sequence !== gs.topicSequence || !$('#graph-topics')) return;
    const crumbs = el('div', { class: 'graph-breadcrumbs' }, button('全部主题', () => chooseGraphTopic(null), 'small subtle'),
      ...result.path.map(item => button(item.name, () => chooseGraphTopic(item.id), 'small subtle')));
    $('#graph-topics').replaceChildren(el('h3', {}, '主题目录'), crumbs,
      ...(result.items.length ? result.items.map(item => button([el('strong', {}, item.name), el('span', {}, `${number(item.memories)} 条直属记忆 · ${number(item.children)} 个子主题`)], () => chooseGraphTopic(item.id), 'graph-topic')) : [el('p', { class: 'muted small' }, gs.topic ? '这是叶主题，没有子主题。' : '尚无主题，后台处理后会逐步出现。')]),
      el('div', { class: 'graph-pager' }, gs.topicOffset ? button('上一页主题', () => { gs.topicOffset = Math.max(0, gs.topicOffset - 20); return loadGraphTopics(); }, 'small') : null,
        result.nextOffset !== null ? button('下一页主题', () => { gs.topicOffset = result.nextOffset; return loadGraphTopics(); }, 'small') : null),
      result.related.length ? el('div', { class: 'graph-related' }, el('h3', {}, '关联主题'), ...result.related.map(item => button(`${item.name} · ${activity(item.strength)}`, () => chooseGraphTopic(item.id), 'small subtle'))) : null);
  }
  async function loadGraphNodes(epoch = state.epoch) {
    const gs = state.graph, sequence = gs.nodeSequence = (gs.nodeSequence || 0) + 1;
    const result = await api('graph-nodes', { topicId: gs.topic, query: gs.query, status: gs.status, offset: gs.offset, limit: 20 });
    if (epoch !== state.epoch || sequence !== gs.nodeSequence || !$('#graph-nodes')) return;
    if (!result.items.some(item => item.id === gs.selected)) gs.selected = null;
    if (!gs.selected) $('#graph-detail')?.replaceChildren(empty('选择一条记忆', '查看内容、主题关联和原文来源。'));
    $('#graph-nodes').replaceChildren(el('p', { class: 'muted small graph-list-note' }, result.search ? '全图相关记忆 · 最多 16 条，按相关性排序' : gs.topic ? '当前主题的直属记忆；子主题可在目录中展开。' : '全部主题中的记忆，按原始时间倒序排列。'),
      ...(result.items.length ? result.items.map(item => button([el('strong', {}, item.gist || '来源已变化，内容已失效'),
        el('span', {}, `${item.protected ? '持续事项 · 受保护' : graphKind[item.kind] || '相关记忆'} · 活跃度 ${activity(item.activation)} · 重要性 ${activity(item.importance)}`),
        item.paths?.length ? el('span', {}, item.paths.join(' / ')) : null], () => loadGraphNode(item.id), 'graph-node', { 'data-node-id': item.id, 'aria-pressed': item.id === gs.selected })) : [empty('没有匹配的记忆', '可以切换主题、浏览状态或搜索关键词。')]),
      el('div', { class: 'graph-pager' }, gs.offset ? button('上一页记忆', () => { gs.offset = Math.max(0, gs.offset - 20); return loadGraphNodes(); }, 'small') : null,
        result.nextOffset !== null ? button('下一页记忆', () => { gs.offset = result.nextOffset; return loadGraphNodes(); }, 'small') : null));
  }
  async function loadGraphNode(id, offset = 0, epoch = state.epoch) {
    const gs = state.graph; gs.selected = id;
    const sequence = gs.detailSequence = (gs.detailSequence || 0) + 1;
    const row = await api('graph-node', { id, offset, limit: 8 });
    if (epoch !== state.epoch || sequence !== gs.detailSequence || gs.selected !== id || !$('#graph-detail')) return;
    document.querySelectorAll('.graph-node').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.nodeId === id)));
    $('#graph-detail').replaceChildren(el('h3', {}, row.recent ? '持续事项' : graphKind[row.kind] || '记忆详情'),
      el('div', { class: 'graph-detail-meta' }, kv([['状态', graphStatus[row.status] || row.status], ['活跃度 / 重要性', `${activity(row.activation)} / ${activity(row.importance)}`],
        ['原始时间', date(row.created_at)], ['衰减参考时间', date(row.reinforced_at)], ['半衰期', `${number(row.half_life_days)} 天`]])),
      row.status === 'stale' ? el('p', { class: 'notice' }, '原文已被编辑或删除，派生内容已经失效。') : el('div', {},
        row.recent ? el('div', {}, el('p', { class: 'muted small' }, row.recent.state === 'Done' ? '事项已结束。' : '事项尚未结束，受保护，不参与普通衰减归档。'), el('pre', {}, row.recent.body + (row.recent.truncated ? '\n（节选）' : ''))) : el('div', {}, el('p', { class: 'message-content' }, row.gist), row.summary ? el('pre', {}, row.summary) : null, row.detail ? el('pre', {}, formatGraphDetail(row.detail)) : null)),
      el('div', { class: 'graph-related' }, ...row.memberships.map(item => button(`${item.name} · ${graphStatus[item.status] || item.status}`, () => chooseGraphTopic(item.id), 'small subtle'))),
      el('h3', { class: 'graph-source-title' }, '原文来源'),
      ...(row.sources.length ? row.sources.map(source => el('article', { class: 'graph-source' }, el('p', { class: 'muted small' }, `${source.role === 'user' ? '用户' : '助手'} · ${date(source.at)}`),
        el('p', { class: 'message-content' }, source.content), source.truncated ? el('p', { class: 'muted small' }, '这里显示原文节选。') : null,
        button('查看完整对话', async () => { state.history.key = source.conversationKey; state.history.query = ''; state.history.from = ''; state.history.to = ''; state.history.offset = 0; state.history.around = source.index; state.history.aroundRevision = source.revision; await navigate('history'); }, 'small subtle'))) : [el('p', { class: 'muted small' }, row.recent ? '正文来自当前 Recent，不复制聊天原文。' : '没有可用的原文来源。')]),
      el('div', { class: 'graph-pager' }, offset ? button('上一页来源', () => loadGraphNode(id, Math.max(0, offset - 8)), 'small') : null,
        row.nextOffset !== null ? button('下一页来源', () => loadGraphNode(id, row.nextOffset), 'small') : null));
  }
  function formatGraphDetail(value) {
    try { const parsed = JSON.parse(value); return [...(parsed.highlights || []).map(item => `${item.text}（${item.status}）\n引用：${item.quote}`), ...(parsed.uncertainties || []).map(item => '待确认：' + (typeof item === 'string' ? item : stringify(item)))].join('\n\n') || stringify(parsed); }
    catch { return value; }
  }

  async function contextPage(epoch) {
    const result = await api('context'); if (epoch !== state.epoch) return;
    const local = result.local;
    const panels = [];
    panels.push(el('p', { class: 'context-intro' }, result.note || '本页展示可观察的本地上下文与恢复元数据。'));
    const grid = el('div', { class: 'context-grid' });
    if (local) {
      const section = (title, entries, body, bodyLabel = '查看内容') => el('section', { class: 'panel context-section' }, el('h3', {}, title), kv(entries), el('details', {}, el('summary', {}, bodyLabel), el('pre', {}, body || '内容为空')));
      grid.append(section('Core', [['来源', '最近一次组装'], ['修订', local.revisions?.core], ['组装时间', date(result.loadedAt)]], local.core),
        section('Recent 目录', [['活跃话题', number(result.recent?.activeCount)], ['全部话题', number(result.recent?.totalCount)], ['修订', local.revisions?.recent]], local.recentDirectory),
        section('心理和动作描写', [['状态', local.expression?.showStageDirections ? '开启' : '关闭'], ['修订', local.revisions?.expression]], local.expression?.instruction),
        section('本地指导', [['来源', '本地上下文组装'], ['组装时间', date(result.loadedAt)]], local.guidance));
    } else grid.append(el('div', { class: 'panel context-section full' }, empty('尚无已组装的上下文快照', '首次请求或内容变更后的下一次请求会生成新的本地快照。')));
    const checkpointPanel = el('section', { class: 'panel context-section full' }, el('div', { class: 'section-heading' }, el('h3', {}, '已保存的上下文'), el('span', { class: 'small' }, `${number(result.checkpoints?.length || 0)} 条记录`)));
    if (!result.checkpoints?.length) checkpointPanel.append(empty('没有已保存的上下文', '会话尚未保存可恢复的上下文状态。'));
    else for (const checkpoint of result.checkpoints) checkpointPanel.append(el('article', { class: 'checkpoint' }, el('div', { class: 'checkpoint-top' }, el('strong', {}, checkpoint.model || '模型未记录'), el('span', {}, checkpoint.archived ? '历史归档' : '会话存档（不代表正在使用）')),
      kv([['存储更新于', date(checkpoint.updatedAt)], ['最近压缩', date(checkpoint.checkpoint?.at || checkpoint.lastCompactedAt)], ['压缩原因', checkpoint.checkpoint?.reason === 'seven_days' ? '7 天触发' : checkpoint.checkpoint?.reason === 'capacity' ? '容量触发' : '未记录'], ['历史游标', number(checkpoint.historyCursor)], ['覆盖校验', checkpoint.coverageVerified === true ? '已验证' : checkpoint.coverageVerified === false ? '未验证' : '未记录'], ['待交付', checkpoint.pendingDelivery ? '有待结算交付' : '无'], ['记录标识', checkpoint.id]])));
    grid.append(checkpointPanel);
    if (result.lastRequest) {
      const request = result.lastRequest;
      grid.append(el('section', { class: 'panel context-section full' }, el('div', { class: 'section-heading' }, el('h3', {}, '最近一次模型调用'), status(request.status)),
        kv([['时间', date(request.at)], ['Provider / 模型', [request.provider, request.model].filter(Boolean).join(' / ') || '未记录'], ['耗时', duration(request.durationMs)], ['上下文变化', request.contextEffect === 'checkpoint_compacted' ? '生成压缩检查点' : request.contextEffect === 'history_windowed' ? '历史窗口调整' : request.contextEffect === 'none' ? '无' : '未回报']]),
        request.usage ? usageRow(request.usage) : el('p', { class: 'trace-note' }, '本次调用未回报用量。'),
        el('p', { class: 'trace-note' }, '正式会话内最近一次实际模型请求；这些数值不是完整上下文大小，也不是整轮调用总量。')));
    }
    grid.append(el('section', { class: 'panel context-section full' }, el('h3', {}, '用量可见性'), el('p', { class: 'small muted' }, result.usage?.note || '当前没有可用的正式会话用量。')));
    panels.push(grid); content.replaceChildren(...panels);
  }
  async function hostPage(epoch) {
    const result = await api('host'); if (epoch !== state.epoch) return;
    renderHost(result);
  }
  function renderHost(result) {
    const samples = Array.isArray(result.samples) ? result.samples : [], latest = samples.at(-1) || {};
    const svgJobs = [], svgNodes = []; hostResize?.disconnect();
    const percentage = (used, total) => typeof used === 'number' && typeof total === 'number' && total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : null;
    const percentText = value => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
    const chart = (fields, percent = false) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); node.setAttribute('class', 'metric-chart'); node.setAttribute('role', 'img'); node.setAttribute('aria-label', fields.map(field => field.label).join('与') + '历史走势');
      svgJobs.push(() => drawChart(node, samples, fields, percent)); svgNodes.push(node); return node;
    };
    const meter = value => { const span = el('span'); span.style.width = `${typeof value === 'number' ? value : 0}%`; return el('div', { class: 'meter', 'aria-label': typeof value === 'number' ? `${value.toFixed(1)}%` : '无数据' }, span); };
    const memoryPercent = percentage(latest.memoryUsedBytes, latest.memoryTotalBytes), swapPercent = percentage(latest.swapUsedBytes, latest.swapTotalBytes), diskPercent = percentage(latest.diskUsedBytes, latest.diskTotalBytes);
    const grid = el('div', { class: 'host-grid' },
      el('section', { class: 'panel metric' }, el('div', { class: 'metric-label' }, 'CPU', el('span', {}, '整体使用率')), el('div', { class: 'metric-value' }, percentText(latest.cpuPercent)), el('div', { class: 'metric-note' }, latest.cpuPercent === null ? '等待相邻样本' : '基于相邻采样的 CPU 时间差'), chart([{ key: 'cpuPercent', label: 'CPU', transform: value => value }], true)),
      el('section', { class: 'panel metric' }, el('div', { class: 'metric-label' }, 'MEMORY', el('span', {}, '主机内存')), el('div', { class: 'metric-value' }, percentText(memoryPercent)), el('div', { class: 'metric-note' }, `${bytes(latest.memoryUsedBytes)} / ${bytes(latest.memoryTotalBytes)}`), chart([{ key: 'memoryUsedBytes', label: '内存', transform: (value, sample) => percentage(value, sample.memoryTotalBytes) }], true)),
      el('section', { class: 'panel metric' }, el('div', { class: 'metric-label' }, 'SWAP', el('span', {}, '交换空间')), el('div', { class: 'metric-value' }, latest.swapTotalBytes === 0 ? '未配置' : percentText(swapPercent)), el('div', { class: 'metric-note' }, latest.swapTotalBytes === null ? '当前系统无法读取' : `${bytes(latest.swapUsedBytes)} / ${bytes(latest.swapTotalBytes)}`), meter(swapPercent)),
      el('section', { class: 'panel metric' }, el('div', { class: 'metric-label' }, 'DISK', el('span', {}, '数据所在文件系统')), el('div', { class: 'metric-value' }, percentText(diskPercent)), el('div', { class: 'metric-note' }, `${bytes(latest.diskUsedBytes)} / ${bytes(latest.diskTotalBytes)}`), meter(diskPercent)),
      el('section', { class: 'panel metric host-network' }, el('div', { class: 'metric-label' }, 'NETWORK', el('span', {}, '非回环接口合计')), el('div', { class: 'network-values' },
        el('div', {}, el('div', { class: 'metric-note' }, el('span', { class: 'legend-dot' }), '接收'), el('div', { class: 'metric-value' }, typeof latest.rxBytesPerSecond === 'number' ? `${bytes(latest.rxBytesPerSecond)}/s` : '—')),
        el('div', {}, el('div', { class: 'metric-note' }, el('span', { class: 'legend-dot secondary' }), '发送'), el('div', { class: 'metric-value' }, typeof latest.txBytesPerSecond === 'number' ? `${bytes(latest.txBytesPerSecond)}/s` : '—'))),
        chart([{ key: 'rxBytesPerSecond', label: '接收', transform: value => value }, { key: 'txBytesPerSecond', label: '发送', transform: value => value }]),
        el('p', { class: 'host-note' }, result.networkInterfaces?.length ? `接口：${result.networkInterfaces.join(' · ')}` : '当前没有可读的网络接口数据。')));
    const nodes = [el('div', { class: 'toolbar' }, el('span', { class: 'small' }, '最近约 10 分钟 · 页面可见时刷新'), el('span', { class: 'small' }, result.at ? `采样于 ${time(result.at)}` : '等待首次采样')), grid,
      el('section', { class: 'panel host-system' }, el('div', { class: 'section-heading' }, el('h3', {}, '主机与进程')), kv([['主机运行时间', uptime(result.uptimeSeconds)], ['Sophon 运行时间', uptime(result.processUptimeSeconds)], ['进程 RSS', bytes(result.rssBytes)], ['保留样本', number(samples.length)]]), ...(result.scopeNotes || []).map(note => el('p', { class: 'host-note' }, note)))];
    content.replaceChildren(...nodes);
    for (const job of svgJobs) job();
    hostResize = new ResizeObserver(() => { for (const job of svgJobs) job(); });
    svgNodes.forEach(node => hostResize.observe(node));
  }
  function drawChart(svg, samples, series, percent) {
    const width = Math.max(180, Math.round(svg.getBoundingClientRect().width || 300)), height = 92, top = 10, bottom = 67, left = 1, right = width - 1;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.replaceChildren();
    const s = (tag, attrs, text) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); if (text !== undefined) node.textContent = text; svg.append(node); return node; };
    const times = samples.map(sample => Date.parse(sample.at));
    const all = series.flatMap(field => samples.map(sample => field.transform(sample[field.key], sample)).filter(value => typeof value === 'number' && Number.isFinite(value)));
    if (!all.length || !times.length) { s('text', { x: width / 2, y: 43, 'text-anchor': 'middle', class: 'chart-empty' }, '等待可用样本'); return; }
    const minTime = times[0], maxTime = Math.max(times.at(-1), minTime + 1), max = percent ? 100 : Math.max(1, ...all) * 1.12;
    const x = at => left + (at - minTime) / (maxTime - minTime) * (right - left), y = value => bottom - Math.min(1, Math.max(0, value / max)) * (bottom - top);
    for (const py of [top, (top + bottom) / 2, bottom]) s('line', { x1: left, y1: py, x2: right, y2: py, class: 'chart-grid' });
    series.forEach((field, index) => {
      let path = '', connected = false;
      samples.forEach((sample, i) => { const value = field.transform(sample[field.key], sample); if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(times[i])) { connected = false; return; } path += `${connected ? 'L' : 'M'}${x(times[i]).toFixed(2)},${y(value).toFixed(2)} `; connected = true; });
      if (path) s('path', { d: path.trim(), class: `chart-line${index ? ' secondary' : ''}` });
      const valid = samples.map((sample, i) => ({ value: field.transform(sample[field.key], sample), at: times[i] })).filter(point => typeof point.value === 'number' && Number.isFinite(point.value));
      if (valid.length === 1) s('circle', { cx: x(valid[0].at), cy: y(valid[0].value), r: 2.5, fill: index ? 'var(--model)' : 'var(--sage)' });
    });
    s('text', { x: left, y: 86, 'text-anchor': 'start' }, time(samples[0].at));
    if (samples.length > 1) s('text', { x: right, y: 86, 'text-anchor': 'end' }, time(samples.at(-1).at));
  }
  $('#navigation').addEventListener('click', event => { const target = event.target.closest('button[data-page]'); if (target) navigate(target.dataset.page).catch(showError); });
  $('#refresh').addEventListener('click', () => navigate(state.page).catch(showError));
  $('#logout').addEventListener('click', async () => {
    if (!canLeave()) return;
    try { await api('logout'); state.dirty = false; setAuthenticated(false); showNotice('已退出控制中心。'); $('#login-code').value = ''; }
    catch (error) { showError(error); }
  });
  async function login() {
    const submit = $('#login-form button'); submit.disabled = true; showNotice('');
    try { const result = await api('login', { code: $('#login-code').value.trim() }); $('#login-code').value = ''; setAuthenticated(result.authenticated === true, result.csrfToken); await navigate('tasks', true); }
    catch (error) { showError(error); }
    finally { submit.disabled = false; }
  }
  $('#login-form').addEventListener('submit', event => { event.preventDefault(); if (!$('#login-form button').disabled) void login(); });
  window.addEventListener('beforeunload', event => { if (!state.dirty) return; event.preventDefault(); event.returnValue = ''; });
  setInterval(async () => {
    if (!state.authenticated || document.hidden || state.pollBusy || state.dirty || document.activeElement?.tagName === 'SELECT' || !['tasks', 'host'].includes(state.page)) return;
    state.pollBusy = true; const epoch = state.epoch;
    try {
      if (state.page === 'host') await hostPage(epoch);
      else {
        const result = await api('tasks', { limit: 30 });
        if (epoch !== state.epoch) return;
        const prior = state.task.runs.find(run => run.id === state.task.selected);
        const keepOlder = state.task.runs.length > 30;
        const fresh = new Set(result.runs.map(run => run.id));
        state.task.runs = [...result.runs, ...state.task.runs.filter(run => !fresh.has(run.id))]
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)).slice(0, 1000);
        if (!keepOlder) state.task.nextBefore = result.nextBefore;
        state.task.heartbeat = result.heartbeat;
        if (result.heartbeat?.timezone) state.timezone = result.heartbeat.timezone;
        $('#task-toolbar')?.replaceWith(taskToolbar());
        const planOpen = $('#task-plan')?.open === true, planSlot = $('#task-plan-slot');
        if (planSlot) replace(planSlot, taskPlan(planOpen));
        if (!state.task.selected) state.task.selected = state.task.runs[0]?.id || null;
        renderTaskList();
        const selected = state.task.runs.find(run => run.id === state.task.selected);
        if (selected && (!prior || selected.status === 'running' || JSON.stringify(prior) !== JSON.stringify(selected))) await loadTaskDetail(selected.id, epoch, true);
      }
      if (epoch === state.epoch) updated();
    } catch (error) { if (state.authenticated && epoch === state.epoch) showError(error); }
    finally { state.pollBusy = false; }
  }, 10_000);
  setAuthenticated(false);
  $('#login-form button').disabled = true;
  api('session').then(async result => {
    const code = entryCode; entryCode = '';
    setAuthenticated(result.authenticated === true, result.csrfToken);
    if (result.authenticated) await navigate('tasks', true);
    else if (code) { $('#login-code').value = code; await login(); }
  }).catch(showError).finally(() => { entryCode = ''; $('#login-form button').disabled = false; });
})();
