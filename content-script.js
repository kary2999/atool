// Inject the WS patcher into the page context (must run at document_start)
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
script.onload = () => script.remove();
(document.head || document.documentElement).prepend(script);

// Relay messages from page to background
window.addEventListener('message', (e) => {
  if (!e.data?.__wsDebug) return;
  // 扩展被重新加载/更新后，旧内容脚本的上下文会失效；
  // chrome.runtime.sendMessage 在这种情况下是「同步抛异常」，.catch() 接不住，
  // 必须用 try/catch 包住，并先检测 runtime 是否还有效。
  try {
    if (!chrome.runtime?.id) return;        // 上下文已失效，直接忽略
    const p = chrome.runtime.sendMessage({ type: 'ws_event', tabId: null, data: e.data });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {
    // Extension context invalidated —— 旧页面刷新即可恢复，这里静默
  }
});
