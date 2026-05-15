// ── 侧栏：点击 toolbar 图标切换开/关 ────────────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {}); // 旧版 Chrome 不支持时静默忽略

// ── 消息路由：把页面捕获的 WS 事件转发给对应 tab 的面板 ──────────
const panels = new Map(); // tabId -> Set<port>

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('ws-panel-')) return;
  const tabId = parseInt(port.name.replace('ws-panel-', ''), 10);
  if (!panels.has(tabId)) panels.set(tabId, new Set());
  panels.get(tabId).add(port);

  port.onDisconnect.addListener(() => {
    panels.get(tabId)?.delete(port);
    if (panels.get(tabId)?.size === 0) panels.delete(tabId);
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== 'ws_event') return;
  const tabId = sender.tab?.id;
  if (!tabId) return;
  for (const port of panels.get(tabId) ?? []) {
    try { port.postMessage({ ...msg.data, tabId, source: 'intercepted' }); } catch {}
  }
});
