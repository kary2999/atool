// Runs in page context — patches window.WebSocket to capture all messages
(function () {
  if (window.__wsInjected) return;
  window.__wsInjected = true;

  const OrigWS = window.WebSocket;

  function WSWrapper(url, protocols) {
    const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    const connId = Math.random().toString(36).slice(2);

    function emit(event) {
      window.postMessage({ __wsDebug: true, connId, url, ...event }, '*');
    }

    emit({ event: 'open_pending' });

    ws.addEventListener('open', () => emit({ event: 'open', ts: Date.now() }));
    ws.addEventListener('close', (e) =>
      emit({ event: 'close', ts: Date.now(), code: e.code, reason: e.reason })
    );
    ws.addEventListener('error', () => emit({ event: 'error', ts: Date.now() }));

    ws.addEventListener('message', async (e) => {
      const payload = await serializeData(e.data);
      emit({ event: 'message', dir: 'recv', ts: Date.now(), payload });
    });

    const origSend = ws.send.bind(ws);
    ws.send = async function (data) {
      const payload = await serializeData(data);
      emit({ event: 'message', dir: 'send', ts: Date.now(), payload });
      return origSend(data);
    };

    return ws;
  }

  // Copy static constants so instanceof / readyState checks work
  WSWrapper.prototype = OrigWS.prototype;
  Object.defineProperty(WSWrapper, 'name', { value: 'WebSocket' });
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => {
    WSWrapper[k] = OrigWS[k];
  });

  window.WebSocket = WSWrapper;

  async function serializeData(data) {
    if (typeof data === 'string') {
      return { kind: 'text', value: data };
    }
    if (data instanceof Blob) {
      const buf = await data.arrayBuffer();
      return { kind: 'binary', bytes: Array.from(new Uint8Array(buf)) };
    }
    if (data instanceof ArrayBuffer) {
      return { kind: 'binary', bytes: Array.from(new Uint8Array(data)) };
    }
    if (ArrayBuffer.isView(data)) {
      return { kind: 'binary', bytes: Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) };
    }
    return { kind: 'text', value: String(data) };
  }
})();
