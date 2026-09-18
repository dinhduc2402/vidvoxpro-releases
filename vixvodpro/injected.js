/**
 * Injected into MAIN world on the Flow page (flow.google.com or labs.google) — has access to window.grecaptcha
 * It only exposes the reCAPTCHA action required for explicit generation calls.
 *
 * Chốt trùng ở đây độc lập với chốt trong content.js: script này sống ở MAIN
 * world, nơi trang Flow có thể tự điều hướng client-side. Nạp lần hai mà không
 * chốt thì `const SITE_KEY` ném `Identifier has already been declared` và cả
 * file chết, nên tab trông như "grecaptcha not available" dù grecaptcha vẫn có.
 */
(function () {
  if (window.__vvpFlowCaptchaLoaded) return;
  window.__vvpFlowCaptchaLoaded = true;

  const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
  const DEBUG_LIMIT = 12000;
  let debugSequence = 0;
  let debugArmedUntil = 0;
  let batchSession = null;

  window.addEventListener('VVP_ARM_FLOW_WIRE_DEBUG', ({ detail }) => {
    const durationMs = Number(detail?.durationMs) || 60000;
    debugArmedUntil = Date.now() + Math.min(Math.max(durationMs, 5000), 120000);
  });

  function batchTarget(url, method) {
    if (String(method || 'GET').toUpperCase() === 'GET') return false;
    try {
      const parsed = new URL(url, location.href);
      return parsed.hostname === 'flow.google.com'
        && parsed.pathname.includes('/batchexecute');
    } catch {
      return false;
    }
  }

  function debugTarget(url, method) {
    return Date.now() <= debugArmedUntil && batchTarget(url, method);
  }

  function rememberBatchSession(url, body) {
    if (!batchTarget(url, 'POST')) return;
    try {
      const parsed = new URL(url, location.href);
      const form = new URLSearchParams(typeof body === 'string' ? body : body?.toString?.() || '');
      const at = form.get('at');
      const sid = parsed.searchParams.get('f.sid');
      const bl = parsed.searchParams.get('bl');
      if (!at || !sid || !bl) return;
      batchSession = {
        at,
        sid,
        bl,
        hl: parsed.searchParams.get('hl') || document.documentElement.lang || 'en-US',
        path: parsed.pathname,
      };
    } catch { /* chờ request batchexecute tiếp theo */ }
  }

  function safeUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      for (const key of ['at', 'f.sid', 'token', 'access_token']) {
        if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '<redacted>');
      }
      return parsed.toString();
    } catch {
      return String(url || '').slice(0, DEBUG_LIMIT);
    }
  }

  function safeBody(body) {
    if (body == null) return null;
    let text;
    if (typeof body === 'string') text = body;
    else if (body instanceof URLSearchParams) text = body.toString();
    else if (typeof body === 'object') {
      try { text = JSON.stringify(body); } catch { text = String(body); }
    } else text = String(body);

    try {
      const params = new URLSearchParams(text);
      if (params.has('f.req') || params.has('at')) {
        for (const key of ['at', 'token', 'access_token', 'authorization']) {
          if (params.has(key)) params.set(key, '<redacted>');
        }
        return params.toString().slice(0, DEBUG_LIMIT);
      }
    } catch { /* giữ nguyên text */ }
    return text
      .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1<redacted>')
      .replace(/("(?:token|access_token|authorization)"\s*:\s*")[^"]+/gi, '$1<redacted>')
      .slice(0, DEBUG_LIMIT);
  }

  function emitWireDebug(detail) {
    window.dispatchEvent(new CustomEvent('VVP_FLOW_WIRE_DEBUG', { detail }));
  }

  function nextDebugId() {
    debugSequence += 1;
    return `${Date.now()}-${debugSequence}`;
  }

  function parseBatchResponse(text, rpcid) {
    const lines = String(text || '').replace(/^\)\]\}'\s*/, '').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('[')) continue;
      let frame;
      try { frame = JSON.parse(trimmed); } catch { continue; }
      if (!Array.isArray(frame)) continue;
      const result = frame.find((item) => (
        Array.isArray(item) && item[0] === 'wrb.fr' && item[1] === rpcid
      ));
      if (!result) continue;
      return typeof result[2] === 'string' ? JSON.parse(result[2]) : result[2];
    }
    throw new Error(`BATCH_RPC_RESULT_NOT_FOUND:${rpcid}`);
  }

  window.addEventListener('VVP_BATCH_RPC_REQUEST', async ({ detail }) => {
    const { requestId, rpcid, payload } = detail || {};
    const finish = (result) => window.dispatchEvent(new CustomEvent(
      'VVP_BATCH_RPC_RESULT', { detail: { requestId, ...result } },
    ));
    if (!requestId || !rpcid) return;
    if (!batchSession) {
      finish({ error: 'NO_BATCH_SESSION' });
      return;
    }
    try {
      const url = new URL(batchSession.path, location.origin);
      url.searchParams.set('rpcids', rpcid);
      url.searchParams.set('source-path', location.pathname || '/');
      url.searchParams.set('bl', batchSession.bl);
      url.searchParams.set('f.sid', batchSession.sid);
      url.searchParams.set('hl', batchSession.hl);
      url.searchParams.set('_reqid', String(Math.floor(Date.now() % 9000000)));
      url.searchParams.set('rt', 'c');
      const form = new URLSearchParams();
      form.set('f.req', JSON.stringify([[[
        rpcid, JSON.stringify(payload), null, 'generic',
      ]]]));
      form.set('at', batchSession.at);
      const response = await nativeFetch(url.toString(), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: form.toString(),
      });
      const raw = await response.text();
      if (!response.ok) {
        finish({ status: response.status, error: `BATCH_RPC_${response.status}`, raw: safeBody(raw) });
        return;
      }
      finish({ status: response.status, data: parseBatchResponse(raw, rpcid) });
    } catch (error) {
      finish({ error: error.message || 'BATCH_RPC_FAILED' });
    }
  });

  // Bắt giao thức thật của app Angular. Không sửa request; clone response chỉ
  // để đọc debug nên trang Flow vẫn nhận nguyên object ban đầu.
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const input = args[0];
    const init = args[1] || {};
    const url = typeof input === 'string' ? input : input?.url;
    const method = init.method || input?.method || 'GET';
    if (batchTarget(url, method)) {
      if (init.body != null) {
        rememberBatchSession(url, init.body);
      } else if (input instanceof Request) {
        input.clone().text().then((body) => rememberBatchSession(url, body)).catch(() => {});
      }
    }
    if (!debugTarget(url, method)) return nativeFetch.apply(this, args);

    const debugId = nextDebugId();
    const wireUrl = safeUrl(url);
    emitWireDebug({
      phase: 'request',
      debugId,
      transport: 'fetch',
      method: String(method).toUpperCase(),
      url: wireUrl,
      body: safeBody(init.body),
    });

    if (init.body == null && input instanceof Request) {
      input.clone().text().then((body) => emitWireDebug({
        phase: 'request_body', debugId, body: safeBody(body),
      })).catch(() => {});
    }

    const pending = nativeFetch.apply(this, args);
    pending.then((response) => {
      response.clone().text().then((body) => emitWireDebug({
        phase: 'response',
        debugId,
        status: response.status,
        url: wireUrl,
        body: safeBody(body),
      })).catch((error) => emitWireDebug({
        phase: 'response', debugId, status: response.status,
        url: wireUrl, error: error.message,
      }));
    }).catch((error) => emitWireDebug({
      phase: 'response', debugId, status: 0, url: wireUrl, error: error.message,
    }));
    return pending;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__vvpWire = { method: String(method || 'GET').toUpperCase(), url };
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__vvpWire;
    if (meta && batchTarget(meta.url, meta.method)) rememberBatchSession(meta.url, body);
    if (!meta || !debugTarget(meta.url, meta.method)) {
      return nativeSend.call(this, body);
    }
    const debugId = nextDebugId();
    const wireUrl = safeUrl(meta.url);
    emitWireDebug({
      phase: 'request', debugId, transport: 'xhr', method: meta.method,
      url: wireUrl, body: safeBody(body),
    });
    this.addEventListener('loadend', () => {
      let responseBody = '';
      try {
        responseBody = typeof this.responseText === 'string'
          ? this.responseText
          : JSON.stringify(this.response);
      } catch { responseBody = '<response unavailable>'; }
      emitWireDebug({
        phase: 'response', debugId, status: this.status, url: wireUrl,
        body: safeBody(responseBody),
      });
    }, { once: true });
    return nativeSend.call(this, body);
  };

  window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
    const { requestId, pageAction } = detail;
    try {
      await waitForGrecaptcha();
      const token = await window.grecaptcha.enterprise.execute(SITE_KEY, {
        action: pageAction,
      });
      window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
        detail: { requestId, token },
      }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
        detail: { requestId, error: e.message },
      }));
    }
  });

  function waitForGrecaptcha(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.grecaptcha?.enterprise?.execute) return resolve();
        if (Date.now() - start > timeout) return reject(new Error('grecaptcha not available'));
        setTimeout(check, 200);
      };
      check();
    });
  }
})();
