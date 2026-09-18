/**
 * Content script — bridge between background.js and injected.js
 * Injects injected.js into MAIN world to access window.grecaptcha
 *
 * Script này chạy hai đường: manifest khai báo nó `document_start` cho các tab
 * Flow, và `requestCaptchaFromTab` tiêm lại khi tab trả "Receiving end does not
 * exist" (sau khi reload extension). Không có chốt thì lần tiêm thứ hai đăng ký
 * thêm một `onMessage` listener và chèn thêm một thẻ `injected.js` nữa: một
 * lượt `GET_CAPTCHA` sinh hai `CAPTCHA_RESULT`, `reply()` bị gọi hai lần (lần
 * sau ném lỗi vì kênh đã đóng), và đốt thừa một lượt captcha execute.
 */
(function () {
  if (window.__vvpFlowBridgeLoaded) return;
  window.__vvpFlowBridgeLoaded = true;

  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);

  window.addEventListener('VVP_FLOW_WIRE_DEBUG', ({ detail }) => {
    if (!detail || typeof detail !== 'object') return;
    chrome.runtime.sendMessage({ type: 'FLOW_WIRE_DEBUG', entry: detail }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg, _, reply) => {
    if (msg.type === 'ARM_FLOW_WIRE_DEBUG') {
      window.dispatchEvent(new CustomEvent('VVP_ARM_FLOW_WIRE_DEBUG', {
        detail: { durationMs: msg.durationMs },
      }));
      reply({ ok: true });
      return;
    }
    if (msg.type === 'BATCH_RPC') {
      const requestId = msg.requestId;
      const handler = (event) => {
        if (event.detail?.requestId !== requestId) return;
        window.removeEventListener('VVP_BATCH_RPC_RESULT', handler);
        clearTimeout(timer);
        reply(event.detail);
      };
      const timer = setTimeout(() => {
        window.removeEventListener('VVP_BATCH_RPC_RESULT', handler);
        reply({ error: 'BATCH_RPC_TIMEOUT' });
      }, 30000);
      window.addEventListener('VVP_BATCH_RPC_RESULT', handler);
      window.dispatchEvent(new CustomEvent('VVP_BATCH_RPC_REQUEST', {
        detail: { requestId, rpcid: msg.rpcid, payload: msg.payload },
      }));
      return true;
    }
    if (msg.type !== 'GET_CAPTCHA') return;

    const { requestId, pageAction } = msg;

    const handler = (e) => {
      if (e.detail?.requestId === requestId) {
        window.removeEventListener('CAPTCHA_RESULT', handler);
        clearTimeout(timer);
        reply({ token: e.detail.token, error: e.detail.error });
      }
    };

    const timer = setTimeout(() => {
      window.removeEventListener('CAPTCHA_RESULT', handler);
      reply({ error: 'CONTENT_TIMEOUT' });
    }, 25000);

    window.addEventListener('CAPTCHA_RESULT', handler);

    window.dispatchEvent(new CustomEvent('GET_CAPTCHA', {
      detail: { requestId, pageAction },
    }));

    return true; // keep channel open for async reply
  });
})();
