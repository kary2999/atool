// Inject the WS patcher into the page context (must run at document_start)
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
script.onload = () => script.remove();
(document.head || document.documentElement).prepend(script);

// Relay messages from page to background
window.addEventListener('message', (e) => {
  if (!e.data?.__wsDebug) return;
  chrome.runtime.sendMessage({ type: 'ws_event', tabId: null, data: e.data }).catch(() => {});
});
