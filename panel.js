// ══════════════════════════════════════════════════════════════════
// 全局状态
// ══════════════════════════════════════════════════════════════════
const messages  = [];
const conns     = new Map();
const pinnedIds = new Set();

let rules     = loadStore('ws_rules', []);
let templates = loadStore('ws_templates', []);
let selected  = null;
let paused    = false;
let dTab      = 'decoded';
let lTab      = 'msg';
let filterConn = '';
let filterText = '';
let filterDir  = 'all';
let activeConnId = null;
let ctxTargetId  = null;

// ══════════════════════════════════════════════════════════════════
// 上下文检测 & 后台连接
// 支持两种运行场景：
//   DevTools 嵌入面板 — chrome.devtools 可用，tabId 直接读取
//   独立侧栏 (Side Panel) — chrome.devtools 不可用，需从 tabs API 获取 tabId
// ══════════════════════════════════════════════════════════════════
const HAS_CHROME  = typeof chrome !== 'undefined' && !!chrome.runtime;
const IS_DEVTOOLS = HAS_CHROME && typeof chrome.devtools !== 'undefined';

let bgPort = null;
let currentTabId = null;

function connectToBackground(tabId) {
  if (!HAS_CHROME) return;
  if (bgPort) { try { bgPort.disconnect(); } catch {} }
  currentTabId = tabId;
  bgPort = chrome.runtime.connect({ name: `ws-panel-${tabId}` });
  bgPort.onMessage.addListener(async (msg) => {
    if (paused) return;
    await handleEvent({ ...msg, source: 'intercepted' });
  });
  bgPort.onDisconnect.addListener(() => {
    // SW 被挂起时重连
    setTimeout(() => connectToBackground(currentTabId), 500);
  });
  updateContextBadge();
}

async function initConnection() {
  if (!HAS_CHROME) return;
  if (IS_DEVTOOLS) {
    connectToBackground(chrome.devtools.inspectedWindow.tabId);
  } else {
    // 侧栏模式：显示提示条
    document.getElementById('sidepanel-bar')?.classList.add('show');

    // 先拿当前 tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) connectToBackground(tab.id);

    // 监听 tab 切换，自动切换监听目标
    chrome.tabs.onActivated.addListener(({ tabId }) => {
      clearAll();
      connectToBackground(tabId);
      updateContextBadge();
    });

    // 监听页面导航（同一 tab 跳转），清空旧数据
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (tabId === currentTabId && info.status === 'loading') {
        clearAll();
      }
    });
  }
}

function updateContextBadge() {
  // 在工具栏第二行显示当前运行模式 + 监听的 tabId
  let badge = document.getElementById('ctx-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'ctx-badge';
    badge.style.cssText = 'font-size:10px;color:#57606a;margin-left:4px;white-space:nowrap;';
    document.getElementById('toolbar-actions')?.appendChild(badge);
  }
  const mode = IS_DEVTOOLS ? 'DevTools' : '侧栏';
  badge.textContent = `${mode} · Tab ${currentTabId ?? '—'}`;
}

initConnection();

// ══════════════════════════════════════════════════════════════════
// 主动 WebSocket 连接
// ══════════════════════════════════════════════════════════════════
function createActiveWS(url, cfg) {
  const connId = 'a-' + Date.now();
  const info = {
    url, type: 'active',
    status: 'connecting',
    ws: null, hbTimer: null, rcTimer: null, rcCount: 0,
    cfg, stats: { recv: 0, send: 0 }
  };
  conns.set(connId, info);
  addConnOption(connId, url, 'active');
  _doConnect(connId);
  renderConnTab();
  return connId;
}

function _doConnect(connId) {
  const info = conns.get(connId);
  if (!info) return;
  let ws;
  try { ws = new WebSocket(info.url); }
  catch (e) { info.status = 'error'; renderConnTab(); return; }

  info.ws = ws;
  info.status = 'connecting';
  renderConnTab();

  ws.onopen = () => {
    info.status = 'open';
    info.rcCount = 0;
    pushEvent({ connId, url: info.url, event: 'open', ts: Date.now(), source: 'active' });

    // 自动发送报文
    for (const payload of (info.cfg.autoSend || [])) {
      _wsSend(connId, typeof payload === 'string' ? payload : JSON.stringify(payload), false);
    }

    // 启动心跳
    if (info.cfg.hbEnable) {
      info.hbTimer = setInterval(() => {
        if (info.ws?.readyState === WebSocket.OPEN) {
          _wsSend(connId, info.cfg.hbMsg, true);
        }
      }, info.cfg.hbInterval * 1000);
    }

    renderConnTab();
    updateSendBar();
  };

  ws.onmessage = async (e) => {
    if (paused) return;
    info.stats.recv++;
    const pl = await serializeData(e.data);
    await pushMsg({ connId, url: info.url, dir: 'recv', ts: Date.now(), source: 'active', payload: pl });
  };

  ws.onclose = (e) => {
    info.status = 'closed';
    clearInterval(info.hbTimer);
    info.hbTimer = null;
    pushEvent({ connId, url: info.url, event: 'close', ts: Date.now(), code: e.code, reason: e.reason, source: 'active' });
    renderConnTab();
    updateSendBar();

    // 自动重连
    if (info.cfg.rcEnable && info.rcCount < info.cfg.rcMax) {
      info.status = 'reconnecting';
      const delay = Math.min(30, Math.pow(2, info.rcCount)) * 1000;
      info.rcCount++;
      pushSysMsg(connId, `${delay/1000}s 后重连（第 ${info.rcCount}/${info.cfg.rcMax} 次）…`);
      info.rcTimer = setTimeout(() => _doConnect(connId), delay);
      renderConnTab();
    }
  };

  ws.onerror = () => {
    info.status = 'error';
    pushEvent({ connId, url: info.url, event: 'error', ts: Date.now(), source: 'active' });
    renderConnTab();
  };
}

function _wsSend(connId, text, isHb) {
  const info = conns.get(connId);
  if (!info?.ws || info.ws.readyState !== WebSocket.OPEN) return false;
  info.ws.send(text);
  if (!isHb) info.stats.send++;
  pushMsg({
    connId, url: info.url, dir: 'send', ts: Date.now(), source: 'active',
    payload: { kind: 'text', value: text }, isHb
  });
  return true;
}

function disconnectConn(connId) {
  const info = conns.get(connId);
  if (!info) return;
  clearInterval(info.hbTimer); info.hbTimer = null;
  clearTimeout(info.rcTimer);  info.rcTimer = null;
  if (info.cfg) info.cfg.rcEnable = false; // 断开后不再自动重连
  info.ws?.close();
  renderConnTab();
}

function reconnectConn(connId) {
  const info = conns.get(connId);
  if (!info) return;
  if (info.cfg) info.cfg.rcEnable = true;
  info.rcCount = 0;
  _doConnect(connId);
}

function updateHb(connId, interval, msg) {
  const info = conns.get(connId);
  if (!info) return;
  clearInterval(info.hbTimer); info.hbTimer = null;
  info.cfg.hbInterval = parseInt(interval) || 30;
  info.cfg.hbMsg = msg || '{"type":"ping"}';
  if (info.cfg.hbEnable && info.status === 'open') {
    info.hbTimer = setInterval(() => {
      if (info.ws?.readyState === WebSocket.OPEN) _wsSend(connId, info.cfg.hbMsg, true);
    }, info.cfg.hbInterval * 1000);
  }
}

function toggleHb(connId, enabled) {
  const info = conns.get(connId);
  if (!info) return;
  info.cfg.hbEnable = enabled;
  clearInterval(info.hbTimer); info.hbTimer = null;
  if (enabled && info.status === 'open') {
    info.hbTimer = setInterval(() => {
      if (info.ws?.readyState === WebSocket.OPEN) _wsSend(connId, info.cfg.hbMsg, true);
    }, info.cfg.hbInterval * 1000);
  }
}

// 发送栏操作
function sendMessage() {
  if (!activeConnId) return;
  const raw = document.getElementById('send-input').value.trim();
  if (!raw) return;
  const fmt = document.getElementById('send-fmt').value;
  let text = raw;
  if (fmt === 'json') {
    try { text = JSON.stringify(JSON.parse(raw)); }
    catch { alert('JSON 格式错误，请检查'); return; }
  }
  if (!_wsSend(activeConnId, text, false)) { alert('连接已断开'); }
}

function disconnectActive() {
  if (activeConnId) disconnectConn(activeConnId);
}

// ══════════════════════════════════════════════════════════════════
// 事件统一入口
// ══════════════════════════════════════════════════════════════════
async function handleEvent(msg) {
  const { event, connId, url, source } = msg;

  if (event === 'open_pending' || event === 'open') {
    if (!conns.has(connId)) {
      conns.set(connId, {
        url, type: 'intercepted', status: 'intercepted',
        ws: null, hbTimer: null, rcTimer: null, rcCount: 0,
        cfg: {}, stats: { recv: 0, send: 0 }
      });
      addConnOption(connId, url, 'intercepted');
      renderConnTab();
    }
    if (event === 'open') pushEvent({ ...msg });
    return;
  }
  if (event === 'message') { await pushMsg({ ...msg }); return; }
  if (event === 'close' || event === 'error') {
    const info = conns.get(connId);
    if (info && info.type === 'intercepted') info.status = 'closed';
    pushEvent({ ...msg });
    renderConnTab();
  }
}

async function pushMsg(msg) {
  const { connId, url, dir, ts, payload, source, isHb } = msg;

  if (!conns.has(connId)) {
    conns.set(connId, {
      url, type: source || 'intercepted', status: 'intercepted',
      ws: null, hbTimer: null, rcTimer: null, rcCount: 0,
      cfg: {}, stats: { recv: 0, send: 0 }
    });
    addConnOption(connId, url, source || 'intercepted');
  }
  const info = conns.get(connId);
  if (dir === 'recv') info.stats.recv++; else info.stats.send++;

  const entry = {
    id: messages.length, connId, url, dir, ts, payload,
    decompressed: null, format: null, pinned: false,
    ruleId: null, source: source || 'intercepted', isHb: !!isHb,
    deleted: false
  };

  if (payload?.kind === 'binary') {
    const r = await autoDecompress(payload.bytes);
    if (r) { entry.decompressed = r.text; entry.format = r.format; }
  }

  const txt = getMsgText(entry);
  const rule = matchRule(txt);
  if (rule) entry.ruleId = rule.id;

  messages.push(entry);
  if (isVisible(entry)) appendRow(entry);
  updateCount();
  updateConnCnt();
}

function pushEvent(ev) {
  const entry = { ...ev, id: messages.length, isEvent: true, deleted: false };
  messages.push(entry);
  if (isVisible(entry)) appendEventRow(entry);
  updateCount();
}

function pushSysMsg(connId, text) {
  const info = conns.get(connId);
  pushEvent({ connId, url: info?.url || '', event: 'sys', ts: Date.now(), source: 'active', label: text });
}

// ══════════════════════════════════════════════════════════════════
// 渲染 — 消息列表
// ══════════════════════════════════════════════════════════════════
function getMsgText(entry) {
  if (entry.decompressed) return entry.decompressed;
  if (entry.payload?.kind === 'text') return entry.payload.value;
  return '';
}

function isVisible(entry) {
  if (entry.deleted) return false;
  if (entry.isEvent) return !filterConn || entry.connId === filterConn;
  if (filterConn && entry.connId !== filterConn) return false;
  if (filterDir !== 'all' && entry.dir !== filterDir) return false;
  if (filterText && !getMsgText(entry).toLowerCase().includes(filterText.toLowerCase())) return false;
  return true;
}

function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function sizeOf(entry) {
  if (!entry.payload) return '';
  return (entry.payload.kind === 'binary' ? entry.payload.bytes.length : (entry.payload.value?.length || 0)) + 'B';
}

function buildMsgRow(entry) {
  const rule = entry.ruleId ? rules.find(r => r.id === entry.ruleId) : null;
  const rl   = rule ? `style="--rl:${rule.color}"` : '';
  const cls  = [
    entry.id === selected ? 'selected' : '',
    rule ? 'rule-hl' : '',
    entry.source === 'active' ? 'active-src' : '',
  ].filter(Boolean).join(' ');
  const dir  = entry.dir === 'send' ? '↑' : '↓';
  const dc   = entry.dir === 'send' ? 'up' : 'dn';
  const prev = getMsgText(entry).slice(0, 120);

  let badges = '';
  if (entry.format === 'gzip')        badges += '<span class="badge gz">gzip</span>';
  else if (entry.format === 'deflate') badges += '<span class="badge zl">zlib</span>';
  else if (entry.format === 'deflate-raw') badges += '<span class="badge dfr">deflate</span>';
  if (entry.source === 'active') badges += '<span class="badge act">主动</span>';
  if (entry.isHb)                badges += '<span class="badge ping">心跳</span>';
  if (rule) badges += `<span class="badge" style="background:${rule.color}22;color:${rule.color}">${esc(rule.name)}</span>`;

  return `<div class="msg-row ${cls}" ${rl} data-id="${entry.id}">
    <span class="dir ${dc}">${dir}</span>
    <span class="ts">${fmtTs(entry.ts)}</span>
    <span class="prev">${esc(prev)}</span>
    <span class="sz">${sizeOf(entry)}</span>
    ${badges}
    <span class="row-acts">
      <button class="pin-btn ${entry.pinned?'pinned':''}"
              title="${entry.pinned?'取消置顶':'置顶'}"
              data-pin="${entry.id}">📌</button>
    </span>
  </div>`;
}

function appendRow(entry) {
  const list = document.getElementById('msg-list');
  list.insertAdjacentHTML('beforeend', buildMsgRow(entry));
  list.scrollTop = list.scrollHeight;
}

function appendEventRow(entry) {
  if (entry.event === 'sys') {
    const list = document.getElementById('msg-list');
    list.insertAdjacentHTML('beforeend',
      `<div class="msg-row" style="color:#57606a;font-style:italic" data-id="${entry.id}">
         <span class="ts">${fmtTs(entry.ts)}</span>
         <span class="prev">${esc(entry.label || '')}</span>
       </div>`);
    list.scrollTop = list.scrollHeight;
    return;
  }
  const cls = `ev-${entry.event}`;
  const src = entry.source === 'active' ? ' [主动]' : ' [捕获]';
  let label;
  if (entry.event === 'open')  label = `⬤ 已连接${src} — ${entry.url}`;
  else if (entry.event === 'close') label = `✕ 已断开 (${entry.code||'—'})${entry.reason?': '+entry.reason:''}${src}`;
  else label = `✕ 连接错误${src}`;
  const list = document.getElementById('msg-list');
  list.insertAdjacentHTML('beforeend',
    `<div class="msg-row ${cls}" data-id="${entry.id}">
       <span class="ts">${fmtTs(entry.ts)}</span>
       <span class="prev">${esc(label)}</span>
     </div>`);
  list.scrollTop = list.scrollHeight;
}

function rerender() {
  document.getElementById('msg-list').innerHTML = '';
  for (const e of messages) {
    if (!isVisible(e)) continue;
    if (e.isEvent) appendEventRow(e);
    else appendRow(e);
  }
  renderPins();
}

function updateCount() {
  const n = messages.filter(e => !e.isEvent && isVisible(e)).length;
  document.getElementById('msg-count').textContent = `${n} / ${messages.length} 条`;
  const badge = document.getElementById('tab-msg-cnt');
  badge.textContent = n > 0 ? n : '';
  badge.classList.toggle('has-count', n > 0);
}

function updateConnCnt() {
  const badge = document.getElementById('tab-conn-cnt');
  badge.textContent = conns.size > 0 ? conns.size : '';
  badge.classList.toggle('has-count', conns.size > 0);
}

// ══════════════════════════════════════════════════════════════════
// 左栏标签切换
// ══════════════════════════════════════════════════════════════════
function switchLeftTab(name) {
  lTab = name;
  document.querySelectorAll('.nav-item').forEach(t => t.classList.remove('on'));
  document.getElementById('ltab-' + name).classList.add('on');

  // 工具模式（SQL / 检索 / 二维码 / JSON / 时间 / 对比）：整块替换 col2+col3，隐藏 WS 工作区
  const TOOL_TABS = ['sql', 'search', 'qr', 'json', 'time', 'diff'];
  const toolMode = TOOL_TABS.includes(name);
  const cpanel = document.getElementById('cpanel');
  const detail = document.getElementById('detail-panel');
  const toolWs = document.getElementById('tool-workspace');
  const toolbar = document.getElementById('toolbar');
  if (toolMode) {
    cpanel.style.display = 'none';
    detail.style.display = 'none';
    if (toolbar) toolbar.style.display = 'none';
    toolWs.classList.add('show');
    document.querySelectorAll('.tool-pane').forEach(p => p.classList.remove('show'));
    document.getElementById('tool-' + name).classList.add('show');
    return;
  }
  // WS 模式：恢复原布局
  cpanel.style.display = 'flex';
  detail.style.display = 'flex';
  if (toolbar) toolbar.style.display = 'flex';
  toolWs.classList.remove('show');

  document.querySelectorAll('.cpane').forEach(p => p.classList.remove('show'));
  const paneMap = { msg: 'msg-tab-pane', conn: 'conn-tab-content', send: 'sendtab-content', diag: 'diagtab-content' };
  document.getElementById(paneMap[name]).classList.add('show');
  const titleMap = { msg: 'MESSAGES', conn: 'CONNECTIONS', send: 'SEND', diag: 'DIAGNOSTICS' };
  document.getElementById('cpanel-title').textContent = titleMap[name];
  if (name === 'conn') renderConnTab();
}

// ══════════════════════════════════════════════════════════════════
// 连接管理标签页
// ══════════════════════════════════════════════════════════════════
function renderConnTab() {
  if (lTab !== 'conn') return;
  const pane = document.getElementById('conn-tab-content');
  if (conns.size === 0) {
    pane.innerHTML = '<p class="hint">暂无连接<br><br><button class="btn primary" data-action="new-conn" style="font-size:12px">＋ 新建连接</button></p>';
    return;
  }
  let html = '';
  for (const [connId, info] of conns) {
    const isActive = info.type === 'active';
    const statusTxt = { open:'已连接', closed:'已断开', connecting:'连接中', reconnecting:'重连中', error:'错误', intercepted:'捕获中' }[info.status] || info.status;
    const dotCls = isActive ? info.status : 'intercepted';
    html += `<div class="conn-card">
      <div class="conn-card-head">
        <span class="conn-type-icon">${isActive ? '🔌' : '💉'}</span>
        <span class="conn-url" title="${esc(info.url)}">${esc(info.url)}</span>
        <span class="status-dot ${dotCls}" title="${statusTxt}"></span>
        <span style="font-size:10px;color:#57606a">${statusTxt}</span>
      </div>
      <div class="conn-meta">
        <span>来源：<b>${isActive?'主动':'页面捕获'}</b></span>
        <span>收 <b>${info.stats.recv}</b> 条</span>
        <span>发 <b>${info.stats.send}</b> 条</span>
      </div>`;

    // 角色说明 —— 让用户明白这条连接是什么、能做什么
    if (isActive) {
      html += `<div class="conn-desc">🔌 你从面板主动建立的连接 —— 可收发消息、配置心跳与自动重连。</div>`;
    } else {
      html += `<div class="conn-desc">💉 网页自身建立、已被监听的连接（只读）—— 可查看其全部收发帧，但无法代它发包。</div>`;
      html += `<div class="conn-actions"><button class="btn primary" data-action="view-msg" data-connid="${connId}">查看消息</button></div>`;
    }

    if (isActive) {
      // 操作按钮
      html += `<div class="conn-actions">`;
      if (info.status === 'open') {
        html += `<button class="btn" data-action="set-active" data-connid="${connId}">发送消息</button>`;
        html += `<button class="btn warn" data-action="disconnect" data-connid="${connId}">断开</button>`;
      } else if (info.status === 'closed' || info.status === 'error') {
        html += `<button class="btn primary" data-action="reconnect" data-connid="${connId}">重新连接</button>`;
      } else if (info.status === 'reconnecting') {
        html += `<button class="btn warn" data-action="disconnect" data-connid="${connId}">取消重连</button>`;
      }
      html += `</div>`;

      // 心跳行
      if (info.status === 'open') {
        const hbOn = info.cfg.hbEnable;
        html += `<div class="hb-row">
          <label>心跳：</label>
          <input type="checkbox" title="启用心跳" ${hbOn?'checked':''}
                 data-action="toggle-hb" data-connid="${connId}">
          <label>每</label>
          <input type="number" value="${info.cfg.hbInterval||30}" min="1" max="300"
                 data-action="hb-interval" data-connid="${connId}" id="hbint-${connId}">
          <label>秒发送</label>
          <input type="text" id="hbmsg-${connId}" value="${esc(info.cfg.hbMsg||'{"type":"ping"}')}"
                 data-action="hb-msg" data-connid="${connId}"
                 style="max-width:160px">
        </div>`;
      }
    }
    html += `</div>`;
  }
  pane.innerHTML = html;
}

function setActiveConn(connId) {
  activeConnId = connId;
  showSendBar(connId);
}

// ══════════════════════════════════════════════════════════════════
// 详情面板
// ══════════════════════════════════════════════════════════════════
function selectMsg(id) {
  selected = id;
  const entry = messages[id];
  if (entry && !entry.isEvent) {
    const info = conns.get(entry.connId);
    if (info?.type === 'active') setActiveConn(entry.connId);
  }
  rerender();
  renderDetail();
}

function switchDTab(name, el) {
  document.querySelectorAll('.dtab').forEach(t => t.classList.remove('on'));
  el.classList.add('on');
  dTab = name;
  renderDetail();
}

function renderDetail() {
  const pane = document.getElementById('detail-content');
  if (selected === null) { pane.innerHTML = '<p class="hint">选择一条消息查看详情</p>'; return; }
  const entry = messages[selected];
  if (!entry) return;

  if (dTab === 'info') {
    const info = conns.get(entry.connId);
    const obj = {
      连接地址: entry.url,
      来源: entry.source === 'active' ? '主动连接' : '页面捕获',
      方向: entry.dir === 'send' ? '发送 ↑' : '接收 ↓',
      时间: entry.ts ? new Date(entry.ts).toISOString() : '—',
      数据类型: entry.payload?.kind || '事件',
      大小: sizeOf(entry),
      压缩格式: entry.format || '无',
      心跳帧: entry.isHb ? '是' : '否',
      匹配规则: entry.ruleId ? (rules.find(r => r.id === entry.ruleId)?.name || '—') : '无',
    };
    pane.innerHTML = `<pre>${esc(JSON.stringify(obj, null, 2))}</pre>`;
    return;
  }
  if (entry.isEvent || !entry.payload) {
    pane.innerHTML = `<pre>${esc(entry.event || entry.label || '')}</pre>`;
    return;
  }
  if (dTab === 'decoded') {
    const raw = entry.decompressed ?? (entry.payload.kind === 'text' ? entry.payload.value : null);
    if (raw === null) { pane.innerHTML = '<p class="hint">二进制数据，无法解压为文本</p>'; return; }
    pane.innerHTML = `<pre>${syntaxHL(tryJSON(raw))}</pre>`;
    return;
  }
  if (dTab === 'raw') {
    const t = entry.payload.kind === 'text' ? entry.payload.value : `[二进制 ${entry.payload.bytes.length} 字节]`;
    pane.innerHTML = `<pre>${esc(t)}</pre>`;
    return;
  }
  if (dTab === 'hex') {
    if (entry.payload.kind !== 'binary') { pane.innerHTML = '<p class="hint">文本帧，无十六进制视图</p>'; return; }
    pane.innerHTML = `<pre>${renderHex(entry.payload.bytes)}</pre>`;
  }
}

function renderHex(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const hex   = chunk.map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const ascii = chunk.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${esc(ascii)}`);
  }
  return lines.join('\n');
}

function copyDetail() {
  if (selected === null) return;
  const entry = messages[selected];
  if (!entry) return;
  let text = '';
  if (dTab === 'decoded' || dTab === 'raw') {
    text = entry.decompressed ?? (entry.payload?.kind === 'text' ? entry.payload.value : '') ?? '';
    if (dTab === 'decoded') text = tryJSON(text);
  } else if (dTab === 'hex' && entry.payload?.kind === 'binary') {
    text = renderHex(entry.payload.bytes).replace(/<[^>]+>/g, '');
  } else if (dTab === 'info') {
    text = document.getElementById('detail-content').innerText;
  }
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copy-btn');
    btn.textContent = '✓ 已复制'; setTimeout(() => btn.textContent = '📋 复制', 1200);
  });
}

// ══════════════════════════════════════════════════════════════════
// 发送栏
// ══════════════════════════════════════════════════════════════════
function showSendBar(connId) {
  const info = conns.get(connId);
  if (!info) return;
  const bar = document.getElementById('send-bar');
  bar.classList.add('visible');
  document.getElementById('send-target-url').textContent = info.url;
  const dot = document.getElementById('send-status-dot');
  dot.className = `status-dot ${info.status}`;
  const inp = document.getElementById('send-input');
  const btn = document.getElementById('send-btn');
  const disabled = info.status !== 'open';
  inp.disabled = btn.disabled = disabled;
  refreshTplSelect();
}

function updateSendBar() {
  if (!activeConnId) return;
  showSendBar(activeConnId);
}

function hideSendBar() {
  document.getElementById('send-bar').classList.remove('visible');
  activeConnId = null;
}

// ══════════════════════════════════════════════════════════════════
// 置顶 Pin
// ══════════════════════════════════════════════════════════════════
function togglePin(id) {
  const e = messages[id]; if (!e) return;
  e.pinned = !e.pinned;
  e.pinned ? pinnedIds.add(id) : pinnedIds.delete(id);
  rerender(); renderDetail();
}

function clearPins() {
  for (const id of pinnedIds) { const e = messages[id]; if (e) e.pinned = false; }
  pinnedIds.clear();
  rerender();
}

function renderPins() {
  const sec  = document.getElementById('pin-section');
  const rows = document.getElementById('pin-rows');
  if (!pinnedIds.size) { sec.style.display = 'none'; rows.innerHTML = ''; return; }
  sec.style.display = 'block';
  document.getElementById('pin-header').firstChild.textContent = `📌 置顶（${pinnedIds.size}）`;
  rows.innerHTML = [...pinnedIds].map(id => messages[id] && !messages[id].isEvent ? buildMsgRow(messages[id]) : '').join('');
}

// ══════════════════════════════════════════════════════════════════
// 右键菜单
// ══════════════════════════════════════════════════════════════════
function openCtx(e, id) {
  e.preventDefault();
  ctxTargetId = id;
  const menu = document.getElementById('ctx-menu');
  menu.style.left = e.clientX + 'px';
  menu.style.top  = e.clientY + 'px';
  menu.classList.add('open');
}

function ctxAction(action) {
  closeCtx();
  const entry = messages[ctxTargetId];
  if (!entry) return;

  if (action === 'copy-decoded') {
    const raw = entry.decompressed ?? (entry.payload?.kind === 'text' ? entry.payload.value : '');
    navigator.clipboard.writeText(tryJSON(raw || ''));
  }
  if (action === 'copy-raw') {
    const raw = entry.payload?.kind === 'text' ? entry.payload.value : `[二进制 ${entry.payload?.bytes?.length} 字节]`;
    navigator.clipboard.writeText(raw || '');
  }
  if (action === 'pin') togglePin(ctxTargetId);
  if (action === 'delete') {
    entry.deleted = true;
    rerender(); updateCount();
    if (selected === ctxTargetId) {
      selected = null;
      document.getElementById('detail-content').innerHTML = '<p class="hint">选择一条消息查看详情</p>';
    }
  }
  if (action === 'resend') {
    if (!activeConnId) { alert('请先选择一个主动连接'); return; }
    const text = entry.payload?.kind === 'text' ? entry.payload.value : null;
    if (!text) { alert('只能重发文本帧'); return; }
    _wsSend(activeConnId, text, false);
  }
}

function closeCtx() {
  document.getElementById('ctx-menu').classList.remove('open');
}

document.addEventListener('click', closeCtx);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeCtx(); return; }

  // Don't intercept when typing in inputs
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  // Up / Down — navigate message list
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const visible = messages.filter(m => !m.isEvent && !m.deleted && isVisible(m));
    if (!visible.length) return;
    const curIdx = visible.findIndex(m => m.id === selected);
    let next;
    if (e.key === 'ArrowUp') {
      next = curIdx <= 0 ? visible[0] : visible[curIdx - 1];
    } else {
      next = curIdx < 0 || curIdx >= visible.length - 1 ? visible[visible.length - 1] : visible[curIdx + 1];
    }
    selectMsg(next.id);
    // scroll selected row into view
    const row = document.querySelector(`.msg-row[data-id="${next.id}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    return;
  }

  // Left / Right — cycle detail tabs
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const tabOrder = ['decoded', 'raw', 'hex', 'info'];
    const curTab = tabOrder.indexOf(dTab);
    const next = e.key === 'ArrowLeft'
      ? tabOrder[(curTab - 1 + tabOrder.length) % tabOrder.length]
      : tabOrder[(curTab + 1) % tabOrder.length];
    const el = document.getElementById('dtab-' + next);
    if (el) switchDTab(next, el);
  }
});

// ══════════════════════════════════════════════════════════════════
// 订阅规则
// ══════════════════════════════════════════════════════════════════
function matchRule(text) {
  if (!text) return null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    try {
      if (rule.matchType === 'keyword' && text.includes(rule.matchValue)) return rule;
      if (rule.matchType === 'regex' && new RegExp(rule.matchValue).test(text)) return rule;
      if (rule.matchType === 'jsonpath') {
        const [key, val] = rule.matchValue.split('=');
        const obj = JSON.parse(text);
        const got = key.split('.').reduce((o, k) => o?.[k], obj);
        if (val !== undefined ? String(got) === val : got !== undefined) return rule;
      }
    } catch {}
  }
  return null;
}

function addRule() {
  const name  = document.getElementById('r-name').value.trim();
  const color = document.getElementById('r-color').value;
  const matchType  = document.getElementById('r-match-type').value;
  const matchValue = document.getElementById('r-match-val').value.trim();
  const autoSend   = document.getElementById('r-auto-send').value.trim();
  if (!name || !matchValue) { alert('规则名称和匹配值不能为空'); return; }
  rules.push({ id: 'r-' + Date.now(), name, color, matchType, matchValue, autoSend, enabled: true });
  saveStore('ws_rules', rules);
  renderRuleList();
  ['r-name','r-match-val','r-auto-send'].forEach(id => document.getElementById(id).value = '');
}

function deleteRule(id) {
  rules = rules.filter(r => r.id !== id);
  saveStore('ws_rules', rules);
  renderRuleList();
}

function toggleRule(id) {
  const r = rules.find(r => r.id === id);
  if (r) r.enabled = !r.enabled;
  saveStore('ws_rules', rules);
  renderRuleList();
}

function renderRuleList() {
  const el = document.getElementById('rule-list');
  if (!rules.length) { el.innerHTML = '<p style="color:#57606a;font-size:12px">暂无订阅规则</p>'; return; }
  el.innerHTML = rules.map(r => `
    <div class="rule-item ${r.enabled?'':'disabled'}">
      <div class="rule-dot" style="background:${r.color}"></div>
      <span class="rule-item-name">${esc(r.name)}</span>
      <span class="rule-item-match">[${r.matchType}] ${esc(r.matchValue)}</span>
      <input type="checkbox" class="rule-toggle" title="启用/禁用" ${r.enabled?'checked':''}
             data-action="toggle-rule" data-ruleid="${r.id}">
      <button class="rule-del" data-action="delete-rule" data-ruleid="${r.id}">✕</button>
    </div>`).join('');
  // 同步新建连接面板的下拉
  const sel = document.getElementById('new-rule-select');
  if (sel) sel.innerHTML = '<option value="">— 不绑定 —</option>' +
    rules.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
}

// ══════════════════════════════════════════════════════════════════
// 发送模板
// ══════════════════════════════════════════════════════════════════
function refreshTplSelect() {
  const sel = document.getElementById('tpl-select');
  sel.innerHTML = '<option value="">— 选择模板 —</option>' +
    templates.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('');
}

function loadTpl() {
  const idx = parseInt(document.getElementById('tpl-select').value);
  if (isNaN(idx)) return;
  document.getElementById('send-input').value = templates[idx]?.content || '';
}

function saveTpl() {
  const content = document.getElementById('send-input').value.trim();
  if (!content) { alert('内容为空'); return; }
  document.getElementById('save-tpl-name').value = '';
  openModal('modal-save-tpl');
  window._pendingTplContent = content;
}

function doSaveTpl() {
  const name = document.getElementById('save-tpl-name').value.trim();
  if (!name) { alert('请填写模板名称'); return; }
  templates.push({ name, content: window._pendingTplContent || '' });
  saveStore('ws_templates', templates);
  renderTplList(); refreshTplSelect();
  closeModal('modal-save-tpl');
}

function addTpl() {
  const name    = document.getElementById('tpl-name').value.trim();
  const content = document.getElementById('tpl-content').value.trim();
  if (!name || !content) { alert('名称和内容不能为空'); return; }
  templates.push({ name, content });
  saveStore('ws_templates', templates);
  renderTplList(); refreshTplSelect();
  document.getElementById('tpl-name').value = '';
  document.getElementById('tpl-content').value = '';
}

function deleteTpl(idx) {
  templates.splice(idx, 1);
  saveStore('ws_templates', templates);
  renderTplList(); refreshTplSelect();
}

function useTpl(idx) {
  document.getElementById('send-input').value = templates[idx]?.content || '';
  closeModal('modal-tpl');
}

function renderTplList() {
  const el = document.getElementById('tpl-list');
  if (!el) return;
  if (!templates.length) { el.innerHTML = '<p style="color:#57606a;font-size:12px">暂无模板</p>'; return; }
  el.innerHTML = templates.map((t, i) => `
    <div class="tpl-item" data-idx="${i}">
      <span class="tpl-item-name">${esc(t.name)}</span>
      <span class="tpl-item-prev">${esc(t.content)}</span>
      <button class="tpl-del" data-action="delete-tpl" data-idx="${i}">✕</button>
    </div>`).join('');
}

// ══════════════════════════════════════════════════════════════════
// 导出
// ══════════════════════════════════════════════════════════════════
function exportMessages() {
  const visible = messages.filter(e => !e.isEvent && isVisible(e));
  const data = visible.map(e => ({
    id: e.id,
    url: e.url,
    direction: e.dir,
    timestamp: new Date(e.ts).toISOString(),
    source: e.source,
    kind: e.payload?.kind,
    size: sizeOf(e),
    compression: e.format || null,
    content: e.decompressed ?? (e.payload?.kind === 'text' ? e.payload.value : null),
  }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ws-messages-${Date.now()}.json`;
  a.click();
}

// ══════════════════════════════════════════════════════════════════
// 工具栏操作
// ══════════════════════════════════════════════════════════════════
function clearAll() {
  messages.length = 0;
  pinnedIds.clear();
  selected = null;
  filterConn = ''; filterText = ''; filterDir = 'all';
  document.getElementById('conn-select').value = '';
  document.getElementById('filter-input').value = '';
  document.querySelectorAll('.tb-dbtn').forEach((b,i) => b.classList.toggle('on', i===0));
  document.getElementById('msg-list').innerHTML = '';
  document.getElementById('pin-rows').innerHTML = '';
  document.getElementById('pin-section').style.display = 'none';
  document.getElementById('detail-content').innerHTML = '<p class="hint">选择一条消息查看详情</p>';
  updateCount();
}

function togglePause() {
  paused = !paused;
  const btn = document.getElementById('pause-btn');
  btn.textContent = paused ? '▶ 继续' : '⏸ 暂停';
  btn.classList.toggle('warn', paused);
}

function setDirFilter(dir, el) {
  filterDir = dir;
  document.querySelectorAll('.tb-dbtn').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
  rerender(); updateCount();
}

function applyFilter() {
  filterConn = document.getElementById('conn-select').value;
  filterText = document.getElementById('filter-input').value;
  rerender(); updateCount();
}

// ══════════════════════════════════════════════════════════════════
// 连接下拉
// ══════════════════════════════════════════════════════════════════
function addConnOption(connId, url, type) {
  const sel = document.getElementById('conn-select');
  if (sel.querySelector(`option[value="${connId}"]`)) return;
  const opt = document.createElement('option');
  opt.value = connId;
  opt.textContent = (type === 'active' ? '🔌 ' : '💉 ') + (url.length > 50 ? url.slice(0, 50) + '…' : url);
  sel.appendChild(opt);
  updateConnCnt();
}

// ══════════════════════════════════════════════════════════════════
// Modal
// ══════════════════════════════════════════════════════════════════
function openNewConnModal() { renderRuleList(); openModal('modal-conn'); }
function openRulesModal()   { renderRuleList(); openModal('modal-rules'); }
function openTplModal()     { renderTplList();  openModal('modal-tpl'); }
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// modal backdrop click handled in bindUI()

function doConnect() {
  const url = document.getElementById('new-url').value.trim();
  if (!url) { alert('请输入 WebSocket 地址'); return; }

  const autoRaw    = document.getElementById('new-auto-send').value.trim();
  const ruleId     = document.getElementById('new-rule-select').value;
  const hbEnable   = document.getElementById('new-hb-enable').value === '1';
  const hbInterval = parseInt(document.getElementById('new-hb-interval').value) || 30;
  const hbMsg      = document.getElementById('new-hb-msg').value.trim() || '{"type":"ping"}';
  const rcEnable   = document.getElementById('new-rc-enable').value === '1';
  const rcMax      = parseInt(document.getElementById('new-rc-max').value) || 5;

  const autoSend = [];
  if (autoRaw) {
    try { const p = JSON.parse(autoRaw); Array.isArray(p) ? autoSend.push(...p) : autoSend.push(p); }
    catch { autoSend.push(autoRaw); }
  }
  if (ruleId) {
    const rule = rules.find(r => r.id === ruleId);
    if (rule?.autoSend) {
      try { const p = JSON.parse(rule.autoSend); Array.isArray(p) ? autoSend.push(...p) : autoSend.push(p); }
      catch { autoSend.push(rule.autoSend); }
    }
  }

  const connId = createActiveWS(url, { autoSend, hbEnable, hbInterval, hbMsg, rcEnable, rcMax, ruleId });
  activeConnId = connId;
  closeModal('modal-conn');
  ['new-url','new-auto-send'].forEach(id => document.getElementById(id).value = '');
}

// ══════════════════════════════════════════════════════════════════
// 工具函数
// ══════════════════════════════════════════════════════════════════
async function serializeData(data) {
  if (typeof data === 'string') return { kind: 'text', value: data };
  if (data instanceof Blob) return { kind: 'binary', bytes: Array.from(new Uint8Array(await data.arrayBuffer())) };
  if (data instanceof ArrayBuffer) return { kind: 'binary', bytes: Array.from(new Uint8Array(data)) };
  if (ArrayBuffer.isView(data)) return { kind: 'binary', bytes: Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) };
  return { kind: 'text', value: String(data) };
}

function tryJSON(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function syntaxHL(json) {
  return esc(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    m => {
      if (/^"/.test(m)) return /:$/.test(m) ? `<span class="jk">${m}</span>` : `<span class="js">${m}</span>`;
      if (/true|false/.test(m)) return `<span class="jb">${m}</span>`;
      if (/null/.test(m)) return `<span class="jb">${m}</span>`;
      return `<span class="jn">${m}</span>`;
    }
  );
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function loadStore(key, def) { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? def; } catch { return def; } }
function saveStore(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// ══════════════════════════════════════════════════════════════════
// 示例数据（预览用）
// ══════════════════════════════════════════════════════════════════
function loadDemoData() {
  clearAll();
  const now = Date.now();
  const samples = [
    { connId:'demo-c1', url:'wss://api.example.com/realtime', source:'intercepted',
      event:'open', ts: now - 9000 },
    { connId:'demo-c1', url:'wss://api.example.com/realtime', source:'intercepted',
      dir:'send', ts: now-8800, payload:{kind:'text', value:'{"type":"subscribe","channel":"prices"}'} },
    { connId:'demo-c1', url:'wss://api.example.com/realtime', source:'intercepted',
      dir:'recv', ts: now-8600, payload:{kind:'text', value:'{"type":"ack","channel":"prices","status":"ok"}'} },
    { connId:'demo-c1', url:'wss://api.example.com/realtime', source:'intercepted',
      dir:'recv', ts: now-7200,
      payload:{kind:'binary', bytes:[0x1f,0x8b,0x08,0x00,0x00,0x00,0x00,0x00,0x00,0x03]},
      _override:{ decompressed:'{"type":"price_update","symbol":"BTCUSDT","price":67234.50,"change":1.24,"volume":18234567.89,"ts":'+now+'}', format:'gzip' }
    },
    { connId:'demo-c2', url:'wss://chat.example.com/ws', source:'intercepted',
      event:'open', ts: now - 6500 },
    { connId:'demo-c2', url:'wss://chat.example.com/ws', source:'intercepted',
      dir:'send', ts: now-6300, payload:{kind:'text', value:'{"action":"join","room":"general","user":"alice"}'} },
    { connId:'demo-c2', url:'wss://chat.example.com/ws', source:'intercepted',
      dir:'recv', ts: now-6100, payload:{kind:'text', value:'{"event":"user_joined","room":"general","user":"alice","members":12}'} },
    { connId:'demo-c1', url:'wss://api.example.com/realtime', source:'intercepted',
      dir:'recv', ts: now-5000,
      payload:{kind:'binary', bytes:[0x78,0x9c,0x01,0x00]},
      _override:{ decompressed:'{"type":"price_update","symbol":"ETHUSDT","price":3521.10,"change":-0.87,"volume":9876543.21}', format:'deflate' }
    },
    { connId:'demo-c2', url:'wss://chat.example.com/ws', source:'intercepted',
      dir:'send', ts: now-4200, payload:{kind:'text', value:'{"action":"message","room":"general","text":"hello!"}'} },
    { connId:'demo-c2', url:'wss://chat.example.com/ws', source:'intercepted',
      dir:'recv', ts: now-4000, payload:{kind:'text', value:'{"event":"message","room":"general","user":"alice","text":"hello!","id":"msg_001"}'} },
    { connId:'demo-c1', url:'wss://api.example.com/realtime', source:'intercepted',
      dir:'send', ts: now-3000, payload:{kind:'text', value:'{"type":"ping","id":42}'}, isHb: true },
    { connId:'demo-c1', url:'wss://api.example.com/realtime', source:'intercepted',
      dir:'recv', ts: now-2900, payload:{kind:'text', value:'{"type":"pong","id":42}'}, isHb: true },
    { connId:'demo-c1', url:'wss://api.example.com/realtime', source:'intercepted',
      dir:'recv', ts: now-1500,
      payload:{kind:'binary', bytes:[0x1f,0x8b,0x08,0x00]},
      _override:{ decompressed:'{"type":"orderbook","symbol":"BTCUSDT","bids":[[67230.0,1.23],[67228.5,0.87]],"asks":[[67235.0,0.45],[67236.5,2.10]]}', format:'gzip' }
    },
    { connId:'demo-c2', url:'wss://chat.example.com/ws', source:'intercepted',
      dir:'recv', ts: now-800, payload:{kind:'text', value:'{"event":"message","room":"general","user":"bob","text":"anyone here?","id":"msg_002"}'} },
  ];

  // 注册连接
  [['demo-c1','wss://api.example.com/realtime'],['demo-c2','wss://chat.example.com/ws']].forEach(([id,url]) => {
    if (!conns.has(id)) {
      conns.set(id, { url, type:'intercepted', status:'intercepted', ws:null, hbTimer:null, rcTimer:null, rcCount:0, cfg:{}, stats:{recv:0,send:0} });
      addConnOption(id, url, 'intercepted');
    }
  });

  for (const s of samples) {
    if (s.event) {
      pushEvent({ connId:s.connId, url:s.url, event:s.event, ts:s.ts, source:s.source });
    } else {
      const entry = {
        id: messages.length, connId:s.connId, url:s.url, dir:s.dir, ts:s.ts,
        payload: s.payload, decompressed: s._override?.decompressed ?? null,
        format: s._override?.format ?? null, pinned:false, ruleId:null,
        source:s.source, isHb:!!s.isHb, deleted:false
      };
      const txt = getMsgText(entry);
      const rule = matchRule(txt);
      if (rule) entry.ruleId = rule.id;
      const info = conns.get(s.connId);
      if (info) { if (s.dir==='recv') info.stats.recv++; else info.stats.send++; }
      messages.push(entry);
      if (isVisible(entry)) appendRow(entry);
    }
  }
  // 默认选中第3条（gzip消息）
  const target = messages.find(e => !e.isEvent && e.format === 'gzip');
  if (target) selectMsg(target.id);
  updateCount(); updateConnCnt();
}


// ══════════════════════════════════════════════════════════════════
// 发包 Tab — 独立 WebSocket 客户端
// ══════════════════════════════════════════════════════════════════
let _stWs = null;
let _stAutoTimer = null;
let _stAutoRunning = false;

function stUpdateUI() {
  const s = _stWs ? _stWs.readyState : -1;
  const dot  = document.getElementById('st-status-dot');
  const txt  = document.getElementById('st-status-text');
  const btn  = document.getElementById('st-connect-btn');
  const send = document.getElementById('st-send-btn');
  const auto = document.getElementById('st-auto-btn');

  if (s === WebSocket.OPEN) {
    dot.className = 'open'; txt.textContent = '已连接';
    btn.textContent = '断开连接'; btn.classList.add('connected');
    send.disabled = false; auto.disabled = false;
  } else if (s === WebSocket.CONNECTING) {
    dot.className = 'connecting'; txt.textContent = '连接中…';
    btn.textContent = '取消'; btn.classList.add('connected');
    send.disabled = true; auto.disabled = true;
  } else {
    dot.className = ''; txt.textContent = '未连接';
    btn.textContent = '开启连接'; btn.classList.remove('connected');
    send.disabled = true; auto.disabled = true;
    stStopAuto();
  }
}

function stConnect() {
  if (_stWs && (_stWs.readyState === WebSocket.OPEN || _stWs.readyState === WebSocket.CONNECTING)) {
    _stWs.close(); return;
  }
  const url = document.getElementById('st-url').value.trim();
  if (!url) { alert('请输入 WebSocket 地址'); return; }
  try { _stWs = new WebSocket(url); } catch(e) { alert('地址格式错误: ' + e.message); return; }
  stUpdateUI();
  _stWs.onopen  = () => stUpdateUI();
  _stWs.onclose = () => { stUpdateUI(); };
  _stWs.onerror = () => { stUpdateUI(); };
  _stWs.onmessage = async (e) => {
    if (paused) return;
    const pl = await serializeData(e.data);
    await pushMsg({ connId: 'st-direct', url, dir: 'recv', ts: Date.now(), source: 'active', payload: pl });
  };
  if (!conns.has('st-direct')) {
    conns.set('st-direct', { url, type: 'active', status: 'open', ws: null, hbTimer: null, rcTimer: null, rcCount: 0, cfg: {}, stats: { recv: 0, send: 0 } });
    addConnOption('st-direct', url, 'active');
  }
}

function stSend() {
  if (!_stWs || _stWs.readyState !== WebSocket.OPEN) return;
  const text = document.getElementById('st-send-input').value;
  if (!text.trim()) return;
  _stWs.send(text);
  const url = document.getElementById('st-url').value.trim();
  pushMsg({ connId: 'st-direct', url, dir: 'send', ts: Date.now(), source: 'active', payload: { kind: 'text', value: text } });
  const info = conns.get('st-direct'); if (info) info.stats.send++;
  if (document.getElementById('st-clear-on-send').checked) {
    document.getElementById('st-send-input').value = '';
  }
}

function stToggleAuto() {
  if (_stAutoRunning) { stStopAuto(); return; }
  if (!_stWs || _stWs.readyState !== WebSocket.OPEN) return;
  const msg = document.getElementById('st-auto-msg').value || 'PING';
  const sec = parseFloat(document.getElementById('st-auto-interval').value) || 1;
  _stAutoRunning = true;
  const btn = document.getElementById('st-auto-btn');
  btn.textContent = '停止发送'; btn.classList.add('running');
  const url = document.getElementById('st-url').value.trim();
  _stAutoTimer = setInterval(() => {
    if (!_stWs || _stWs.readyState !== WebSocket.OPEN) { stStopAuto(); return; }
    _stWs.send(msg);
    pushMsg({ connId: 'st-direct', url, dir: 'send', ts: Date.now(), source: 'active', payload: { kind: 'text', value: msg }, isHb: true });
  }, sec * 1000);
}

function stStopAuto() {
  clearInterval(_stAutoTimer); _stAutoTimer = null; _stAutoRunning = false;
  const btn = document.getElementById('st-auto-btn');
  if (btn) { btn.textContent = '开始发送'; btn.classList.remove('running'); }
}

// ══════════════════════════════════════════════════════════════════
// 发包 Tab — 本地模板
// ══════════════════════════════════════════════════════════════════
let stTemplates = loadStore('ws_st_templates', []);

function renderStTplSelect() {
  const sel = document.getElementById('st-tpl-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">— 选择模板 —</option>' +
    stTemplates.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('');
}

function stLoadTpl() {
  const idx = parseInt(document.getElementById('st-tpl-select').value);
  if (isNaN(idx)) return;
  const tpl = stTemplates[idx];
  if (!tpl) return;
  document.getElementById('st-send-input').value = tpl.content;
  if (tpl.url) document.getElementById('st-url').value = tpl.url;
}

function stSaveTpl() {
  const content = document.getElementById('st-send-input').value.trim();
  if (!content) { alert('内容为空，无法保存'); return; }
  const name = prompt('请输入模板名称：');
  if (!name || !name.trim()) return;
  const url = document.getElementById('st-url').value.trim();
  stTemplates.push({ name: name.trim(), content, url });
  saveStore('ws_st_templates', stTemplates);
  renderStTplSelect();
  const sel = document.getElementById('st-tpl-select');
  sel.value = String(stTemplates.length - 1);
}

function stDeleteTpl() {
  const idx = parseInt(document.getElementById('st-tpl-select').value);
  if (isNaN(idx)) { alert('请先选择一个模板'); return; }
  const name = stTemplates[idx]?.name || '';
  if (!confirm(`确认删除模板"${name}"？`)) return;
  stTemplates.splice(idx, 1);
  saveStore('ws_st_templates', stTemplates);
  renderStTplSelect();
}

// ══════════════════════════════════════════════════════════════════
// 诊断 Tab — WSS 连接检测
// ══════════════════════════════════════════════════════════════════
const diagHistory = [];
let _diagWs     = null;
let _diagTimer  = null;
let _diagRunning = false;

function diagRun() {
  if (_diagRunning) return;
  const url     = document.getElementById('diag-url').value.trim();
  if (!url) { alert('请输入要检测的地址'); return; }
  const proto   = document.getElementById('diag-proto').value.trim();
  const timeout = (parseInt(document.getElementById('diag-timeout').value) || 10) * 1000;

  let hostname;
  try {
    const u = new URL(url.replace(/^wss?:\/\//, s => s === 'wss://' ? 'https://' : 'http://'));
    hostname = u.hostname;
  } catch { alert('地址格式错误'); return; }

  _diagRunning = true;
  document.getElementById('diag-run-btn').disabled = true;
  document.getElementById('diag-current-section').style.display = '';
  document.getElementById('diag-current-url').textContent = url;

  const steps = [];
  const t0 = Date.now();

  function addStep(icon, name, msg, timeMs) {
    steps.push({ icon, name, msg, timeMs });
    _renderDiagSteps(steps);
  }

  function replaceLastStep(icon, name, msg, timeMs) {
    steps[steps.length - 1] = { icon, name, msg, timeMs };
    _renderDiagSteps(steps);
  }

  function finish(ok, totalMs, errorMsg) {
    _diagRunning = false;
    document.getElementById('diag-run-btn').disabled = false;
    clearTimeout(_diagTimer);
    if (_diagWs) { try { _diagWs.close(); } catch {} _diagWs = null; }
    diagHistory.unshift({ url, ok, totalMs, errorMsg, ts: Date.now() });
    if (diagHistory.length > 20) diagHistory.pop();
    _renderDiagHist();
  }

  function startWsTest(dnsMs) {
    if (dnsMs !== null) addStep('✓', 'DNS 解析', hostname, dnsMs);
    const wsStart = Date.now();
    addStep('⏳', 'WebSocket 握手', '连接中…', null);

    let ws;
    try {
      ws = proto ? new WebSocket(url, proto) : new WebSocket(url);
    } catch (e) {
      replaceLastStep('✕', 'WebSocket 握手', e.message, Date.now() - wsStart);
      finish(false, Date.now() - t0, e.message);
      return;
    }
    _diagWs = ws;

    ws.onopen = () => {
      const dt = Date.now() - wsStart;
      replaceLastStep('✓', 'WebSocket 握手', `握手成功${ws.protocol ? '，协议: ' + ws.protocol : ''}`, dt);
      addStep('✅', '检测完成', `总用时 ${Date.now() - t0}ms`, null);
      finish(true, Date.now() - t0, null);
    };

    ws.onclose = (e) => {
      if (!_diagRunning) return;
      const dt = Date.now() - wsStart;
      const errMsg = e.reason || (e.code !== 1000 ? `握手失败 (code ${e.code})` : '服务端立即关闭连接');
      replaceLastStep('✕', 'WebSocket 握手', errMsg, dt);
      finish(false, Date.now() - t0, errMsg);
    };

    ws.onerror = () => {};
  }

  // DNS resolution via chrome.dns if available
  const dnsStart = Date.now();
  if (HAS_CHROME && chrome.dns && typeof chrome.dns.resolve === 'function') {
    addStep('⏳', 'DNS 解析', `解析 ${hostname}…`, null);
    chrome.dns.resolve(hostname, (info) => {
      if (chrome.runtime.lastError) {
        const err = chrome.runtime.lastError.message;
        replaceLastStep('✕', 'DNS 解析', `${hostname} — ${err}`, Date.now() - dnsStart);
        finish(false, Date.now() - t0, 'DNS 解析失败: ' + err);
        return;
      }
      replaceLastStep('✓', 'DNS 解析', `${hostname} → ${info?.address || '已解析'}`, Date.now() - dnsStart);
      startWsTest(null);
    });
  } else {
    startWsTest(null);
  }

  _diagTimer = setTimeout(() => {
    if (!_diagRunning) return;
    if (steps.length && steps[steps.length - 1].icon === '⏳') {
      replaceLastStep('⏱', steps[steps.length - 1].name, `超时 (${timeout/1000}s)`, Date.now() - t0);
    }
    if (_diagWs) { try { _diagWs.close(); } catch {} _diagWs = null; }
    _diagRunning = false;
    document.getElementById('diag-run-btn').disabled = false;
    diagHistory.unshift({ url, ok: false, totalMs: Date.now() - t0, errorMsg: `连接超时 (${timeout/1000}s)`, ts: Date.now() });
    if (diagHistory.length > 20) diagHistory.pop();
    _renderDiagHist();
  }, timeout);
}

function _renderDiagSteps(steps) {
  document.getElementById('diag-steps').innerHTML = steps.map(s =>
    `<div class="diag-step">
      <span class="diag-step-icon">${s.icon}</span>
      <span class="diag-step-name">${esc(s.name)}</span>
      <span class="diag-step-msg">${esc(s.msg || '')}</span>
      ${s.timeMs !== null && s.timeMs !== undefined ? `<span class="diag-step-time">${s.timeMs}ms</span>` : ''}
    </div>`
  ).join('');
}

function _renderDiagHist() {
  const el = document.getElementById('diag-hist');
  if (!diagHistory.length) {
    el.innerHTML = '<p style="color:#57606a;font-size:11px;text-align:center;padding:10px 0">暂无检测记录</p>';
    return;
  }
  el.innerHTML = diagHistory.map(h =>
    `<div class="diag-hist-item">
      <span style="font-size:13px;flex-shrink:0">${h.ok ? '✅' : '❌'}</span>
      <span class="diag-hist-url" title="${esc(h.url)}">${esc(h.url)}</span>
      <span class="diag-hist-ms">${h.totalMs}ms</span>
      <span class="diag-hist-ts">${fmtTs(h.ts)}</span>
    </div>`
  ).join('');
}

function diagClear() {
  if (_diagRunning) return;
  diagHistory.length = 0;
  _renderDiagHist();
  document.getElementById('diag-current-section').style.display = 'none';
  document.getElementById('diag-steps').innerHTML = '';
}

// ══════════════════════════════════════════════════════════════════
// 事件绑定（CSP 兼容 — 无 inline handler）
// ══════════════════════════════════════════════════════════════════
function bindUI() {
  // 工具栏
  document.getElementById('clear-btn').addEventListener('click', clearAll);
  document.getElementById('pause-btn').addEventListener('click', togglePause);
  document.getElementById('conn-select').addEventListener('change', applyFilter);
  document.getElementById('filter-input').addEventListener('input', applyFilter);
  document.getElementById('dir-all').addEventListener('click', function() { setDirFilter('all', this); });
  document.getElementById('dir-recv').addEventListener('click', function() { setDirFilter('recv', this); });
  document.getElementById('dir-send').addEventListener('click', function() { setDirFilter('send', this); });
  document.getElementById('new-conn-btn').addEventListener('click', openNewConnModal);
  document.getElementById('rules-btn').addEventListener('click', openRulesModal);
  document.getElementById('tpl-modal-btn').addEventListener('click', openTplModal);
  document.getElementById('export-btn').addEventListener('click', exportMessages);
  document.getElementById('demo-btn').addEventListener('click', loadDemoData);

  // 发包 Tab
  document.getElementById('ltab-send').addEventListener('click', function() { switchLeftTab('send'); });
  document.getElementById('st-connect-btn').addEventListener('click', stConnect);
  document.getElementById('st-send-btn').addEventListener('click', stSend);
  document.getElementById('st-auto-btn').addEventListener('click', stToggleAuto);
  document.getElementById('st-tpl-load-btn').addEventListener('click', stLoadTpl);
  document.getElementById('st-tpl-save-btn').addEventListener('click', stSaveTpl);
  document.getElementById('st-tpl-del-btn').addEventListener('click', stDeleteTpl);

  // 诊断 Tab
  document.getElementById('ltab-diag').addEventListener('click', function() { switchLeftTab('diag'); });
  document.getElementById('diag-run-btn').addEventListener('click', diagRun);
  document.getElementById('diag-clear-btn').addEventListener('click', diagClear);
  document.getElementById('diag-url').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') diagRun();
  });

  // 侧栏关闭提示
  document.getElementById('sidepanel-close').addEventListener('click', function() {
    document.getElementById('sidepanel-bar').classList.remove('show');
  });

  // 左栏 tab
  document.getElementById('ltab-msg').addEventListener('click', function() { switchLeftTab('msg'); });
  document.getElementById('ltab-conn').addEventListener('click', function() { switchLeftTab('conn'); });

  // 置顶清除
  document.getElementById('clear-pins-btn').addEventListener('click', clearPins);

  // 详情 tab
  document.getElementById('dtab-decoded').addEventListener('click', function() { switchDTab('decoded', this); });
  document.getElementById('dtab-raw').addEventListener('click', function() { switchDTab('raw', this); });
  document.getElementById('dtab-hex').addEventListener('click', function() { switchDTab('hex', this); });
  document.getElementById('dtab-info').addEventListener('click', function() { switchDTab('info', this); });
  document.getElementById('copy-btn').addEventListener('click', copyDetail);

  // 发送栏
  document.getElementById('disconnect-active-btn').addEventListener('click', disconnectActive);
  document.getElementById('tpl-select').addEventListener('change', loadTpl);
  document.getElementById('save-tpl-btn').addEventListener('click', saveTpl);
  document.getElementById('send-btn').addEventListener('click', sendMessage);

  // Modal 通用关闭按钮（data-close="modal-id"）
  document.querySelectorAll('[data-close]').forEach(function(btn) {
    btn.addEventListener('click', function() { closeModal(this.dataset.close); });
  });
  // Modal 背景点击关闭
  document.querySelectorAll('.modal-mask').forEach(function(m) {
    m.addEventListener('click', function(e) { if (e.target === m) m.classList.remove('open'); });
  });

  // Modal 内部操作按钮
  document.getElementById('do-connect-btn').addEventListener('click', doConnect);
  document.getElementById('add-rule-btn').addEventListener('click', addRule);
  document.getElementById('add-tpl-btn').addEventListener('click', addTpl);
  document.getElementById('do-save-tpl-btn').addEventListener('click', doSaveTpl);

  // 右键菜单委托
  document.getElementById('ctx-menu').addEventListener('click', function(e) {
    var item = e.target.closest('[data-ctx]');
    if (item) ctxAction(item.dataset.ctx);
  });

  // 消息列表委托（点击 + 右键 + pin）
  function msgListDelegate(el) {
    el.addEventListener('click', function(e) {
      var pin = e.target.closest('[data-pin]');
      if (pin) { e.stopPropagation(); togglePin(parseInt(pin.dataset.pin)); return; }
      var row = e.target.closest('.msg-row[data-id]');
      if (row) selectMsg(parseInt(row.dataset.id));
    });
    el.addEventListener('contextmenu', function(e) {
      var row = e.target.closest('.msg-row[data-id]');
      if (row) openCtx(e, parseInt(row.dataset.id));
    });
  }
  msgListDelegate(document.getElementById('msg-list'));
  msgListDelegate(document.getElementById('pin-rows'));

  // 连接管理委托
  document.getElementById('conn-tab-content').addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.dataset.action;
    var connId = btn.dataset.connid;
    if (action === 'new-conn')  { openNewConnModal(); }
    if (action === 'set-active'){ setActiveConn(connId); switchLeftTab('msg'); }
    if (action === 'view-msg'){
      var sel = document.getElementById('conn-select');
      if (sel) sel.value = connId;     // 把消息列表过滤到该连接
      applyFilter();
      switchLeftTab('msg');
    }
    if (action === 'disconnect'){ disconnectConn(connId); }
    if (action === 'reconnect') { reconnectConn(connId); }
  });
  document.getElementById('conn-tab-content').addEventListener('change', function(e) {
    var el = e.target;
    var action = el.dataset.action;
    var connId = el.dataset.connid;
    if (action === 'toggle-hb') { toggleHb(connId, el.checked); }
    if (action === 'hb-interval') {
      var msg = document.getElementById('hbmsg-' + connId);
      updateHb(connId, el.value, msg ? msg.value : '{"type":"ping"}');
    }
    if (action === 'hb-msg') {
      var interval = document.getElementById('hbint-' + connId);
      updateHb(connId, interval ? interval.value : 30, el.value);
    }
  });

  // 规则列表委托
  document.getElementById('rule-list').addEventListener('change', function(e) {
    if (e.target.dataset.action === 'toggle-rule') toggleRule(e.target.dataset.ruleid);
  });
  document.getElementById('rule-list').addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action="delete-rule"]');
    if (btn) deleteRule(btn.dataset.ruleid);
  });

  // 模板列表委托
  document.getElementById('tpl-list').addEventListener('click', function(e) {
    var del = e.target.closest('[data-action="delete-tpl"]');
    if (del) { e.stopPropagation(); deleteTpl(parseInt(del.dataset.idx)); return; }
    var item = e.target.closest('.tpl-item[data-idx]');
    if (item) useTpl(parseInt(item.dataset.idx));
  });
}

// ══════════════════════════════════════════════════════════════════
// 初始化
// ══════════════════════════════════════════════════════════════════
bindUI();
renderRuleList();
refreshTplSelect();
renderStTplSelect();
updateConnCnt();
