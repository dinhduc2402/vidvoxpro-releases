/**
 * VidVoxPro — Chrome Extension Background Service Worker
 *
 * Connects directly to the VidVoxPro process over its WebSocket bridge.
 * Captures bearer token, solves reCAPTCHA, proxies API calls through browser.
 */

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:9222';

// ─── Flow domains ───────────────────────────────────────────
//
// 2026-09-05: Google dời Flow sang `flow.google.com`. Domain cũ VẪN phục vụ
// app (đo được HTTP 200) và tRPC cũ vẫn trả 200, nên giữ cả hai thay vì đổi.
//
// Mọi nơi cần tab Flow phải dùng đúng hằng số này. Trước đây danh sách bị
// chép tay ở năm chỗ `chrome.tabs.query`; khi domain đổi thì cả năm cùng
// trượt, `solve_captcha` trả NO_FLOW_TAB và MỌI lượt sinh ảnh/video 403.
const FLOW_TAB_PATTERNS = [
  'https://flow.google.com/*',
  'https://labs.google/fx/tools/flow*',
  'https://labs.google/fx/*/tools/flow*',
];

// Tab này CHỈ để giải captcha — token không còn lấy từ tab nữa, xem
// `mintToken()`. Đo 2026-09-14: URL này trả 308 sang `flow.google.com`, nên
// tab mở ra luôn đáp xuống domain mới. Vẫn khớp `FLOW_TAB_PATTERNS` nên
// `solveCaptcha` dùng được; giữ nguyên URL vì nó là đường vào chính chủ và
// Google có thể đổi đích chuyển hướng bất cứ lúc nào.
const FLOW_TAB_URL = 'https://labs.google/fx/tools/flow';

// Host được phép nhận lệnh trpc_request từ engine.
const FLOW_TRPC_ORIGINS = [
  'https://labs.google/',
  'https://flow.google.com/',
];

// `chrome-extension://<id>` — dùng để nhận ra request do chính extension phát.
const EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
let ws = null;
let bridgeUrl = DEFAULT_BRIDGE_URL;
let initPromise = null;
let flowKey = null;
let flowKeySource = null;
let state = 'off'; // off | idle | running
let manualDisconnect = false;
let metrics = {
  tokenCapturedAt: null,
  tokenExpiresAt: null,   // mốc epoch ms, null khi nguồn không nói hạn
  requestCount: 0,   // captcha-consuming requests only (gen image/video/upscale)
  successCount: 0,
  failedCount: 0,
  lastError: null,
};

// ─── URL → Log Type Classifier ─────────────────────────────

// Visible log types — only these appear in the request log
const _VISIBLE_TYPES = new Set(['GEN_IMG', 'GEN_VID', 'GEN_VID_REF', 'UPSCALE', 'TRACKING', 'URL_REFRESH']);

function _classifyApiUrl(url) {
  if (url.includes('uploadImage'))                     return 'UPLOAD';
  if (url.includes('batchGenerateImages'))              return 'GEN_IMG';
  if (url.includes('UpsampleVideo'))                   return 'UPSCALE';
  if (url.includes('ReferenceImages'))                 return 'GEN_VID_REF';
  if (url.includes('batchAsyncGenerateVideo'))          return 'GEN_VID';
  if (url.includes('batchCheckAsync'))                  return 'POLL';
  if (url.includes('upsampleImage'))                   return 'UPS_IMG';
  if (url.includes('/media/'))                         return 'MEDIA';
  if (url.includes('/credits'))                        return 'CREDITS';
  return 'API';
}

// ─── Request Log ────────────────────────────────────────────

let requestLog = [];

function addRequestLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 100) requestLog.pop();
  broadcastRequestLog();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) Object.assign(entry, updates);
  broadcastRequestLog();
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

function summarizeApiResponse(data) {
  const shape = Array.isArray(data)
    ? `array(${data.length})`
    : data && typeof data === 'object'
      ? `object(${Object.keys(data).sort().join(',') || 'empty'})`
      : typeof data;

  const operationIds = [];
  const queue = [data];
  const seen = new Set();
  while (queue.length && seen.size < 100) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value.operations)) {
      for (const item of value.operations) {
        const name = item?.operation?.name;
        if (name) operationIds.push(name);
      }
    }
    if (Array.isArray(value)) {
      queue.push(...value.slice(0, 20));
    } else {
      for (const key of ['data', 'result', 'response']) {
        if (value[key] && typeof value[key] === 'object') queue.push(value[key]);
      }
    }
  }
  return { shape, operationIds: [...new Set(operationIds)] };
}

// ─── Startup ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());
chrome.alarms.onAlarm.addListener(async (alarm) => {
  await init();
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'keepAlive') keepAlive();
  if (alarm.name === 'token-refresh') {
    await refreshToken();
  }
});

function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const data = await chrome.storage.local.get([
      'flowKey', 'flowKeySource', 'metrics', 'manualDisconnect', 'bridgeUrl',
    ]);
    if (data.flowKey) flowKey = data.flowKey;
    if (data.flowKeySource) flowKeySource = data.flowKeySource;
    if (data.metrics) Object.assign(metrics, data.metrics);
    manualDisconnect = !!data.manualDisconnect;
    bridgeUrl = data.bridgeUrl || DEFAULT_BRIDGE_URL;
    connectToAgent();
    chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
  })();
  return initPromise;
}

// ─── Token Capture ──────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token) return;

    // Bỏ request do chính extension phát ra. `handleApiRequest` tự đính bearer
    // rồi fetch sang aisandbox-pa, nên webRequest bắt lại token của chính mình.
    // Hệ quả (đo 2026-09-14): `tokenCapturedAt` được làm mới ở mỗi lượt gọi API
    // nên tuổi token báo vài phút trong khi token thật đã quá hạn và đang 403;
    // đồng thời `flowKeySource` bị ghim cứng vào `aisandbox-pa.googleapis.com`.
    //
    // Chỗ ghim đó từng đi kèm một bộ lọc bỏ qua mọi token không đến từ
    // aisandbox-pa. Đường mint khi đó nạp `labs.google`, nơi token phát về
    // chính `labs.google/*`, nên sau lượt generate đầu tiên mọi lần mint đều
    // bị vứt. Lọc self-request đúng chỗ thì không cần phân biệt nguồn nữa —
    // cả hai domain đều phát cùng token của user.
    if (details.initiator && details.initiator === EXTENSION_ORIGIN) return;

    // Always update — even if same token string, refresh the timestamp.
    // Không biết hạn: header không nói token sống tới bao giờ.
    adoptToken(token, new URL(details.url).hostname, null);
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*', 'https://flow.google.com/*'] },
  ['requestHeaders', 'extraHeaders'],
);

/** Ghi nhận một bearer token mới, từ nguồn nào cũng vậy.
 *
 * `expiresAt` là mốc epoch ms, hoặc null khi nguồn không nói hạn.
 */
function adoptToken(token, sourceHost, expiresAt) {
  flowKey = token;
  flowKeySource = sourceHost;
  metrics.tokenCapturedAt = Date.now();
  metrics.tokenExpiresAt = expiresAt || null;
  metrics.needsLogin = false;
  chrome.storage.local.set({ flowKey, flowKeySource, metrics });
  console.log('[FlowAgent] Bearer token captured from', sourceHost);

  // Notify VidVoxPro about readiness; the bearer token never leaves the extension.
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'token_captured', source: sourceHost }));
  }
}

/** Tab Flow thật đang mở.
 *
 * Một chỗ duy nhất định nghĩa truy vấn này. Trước đây hàm còn phải loại tab
 * tạm của lượt mint; `mintToken()` không mở tab nào nữa nên bộ lọc đó đã bỏ.
 */
async function queryFlowTabs() {
  return chrome.tabs.query({ url: FLOW_TAB_PATTERNS });
}

// ─── Token Mint ─────────────────────────────────────────────
//
// Đo 2026-09-14: `labs.google/fx/tools/flow` trả 308 vĩnh viễn sang
// `flow.google.com`. Nạp trang đó không còn khởi động app Next.js, nên nó
// không bao giờ phát `Bearer ya29.` nữa — mọi lượt mint bằng cách mở tab đều
// hết giờ. Nhưng ENDPOINT session của app cũ thì VẪN sống và trả JSON thật,
// nên token lấy thẳng được: không tab, không chờ, không sniff header.
//
// `flow.google.com` trả 200 kèm index.html của app Angular cho MỌI path lạ,
// nên KHÔNG được tin mỗi status — phải kiểm `content-type` có `json`.
//
// Đo 2026-09-15: flow.google.com HIỆN KHÔNG có NextAuth — cả
// `/api/auth/session` lẫn `/api/auth/providers` đều trả SPA fallback. Hai URL
// đó giữ lại thuần tuý để phòng ngày Google dời endpoint sang đó; hôm nay
// chúng luôn bị bộ lọc content-type loại, và đó là hành vi đúng.
// Trang đăng nhập lại phiên NextAuth.
//
// Phải là endpoint `/fx/api/auth/signin`, KHÔNG phải trang app nào của
// labs.google. Đo 2026-09-15:
//
//   labs.google/fx/tools/flow      308 sang flow.google.com ngay ở tầng HTTP
//   labs.google/fx/                200 text/html, nhưng JS của app tự đẩy
//                                  sang flow.google.com sau khi nạp
//   labs.google/fx/api/auth/signin 200 text/html — trang NextAuth server
//                                  render, có nút "Sign in with Google" POST
//                                  sang /fx/api/auth/signin/google kèm
//                                  csrfToken. Không nạp JS của app nên KHÔNG
//                                  bị đẩy đi đâu.
//
// Đây là mấu chốt: phiên cần gia hạn nằm ở labs.google, mà mọi trang app của
// labs.google đều đẩy người dùng sang domain mới — nên họ không bao giờ đứng
// lại đủ lâu để đăng nhập, và phiên cứ thế mục.
const LOGIN_URL = 'https://labs.google/fx/api/auth/signin';

const SESSION_URLS = [
  'https://labs.google/fx/api/auth/session',
  'https://flow.google.com/api/auth/session',
  'https://flow.google.com/fx/api/auth/session',
];

/** Token trong payload session.
 *
 * Bản hiện tại dùng snake_case. `accessToken` là tên cũ còn sót lại và có thể
 * đã hết hạn trong khi `access_token` là token vừa được làm mới — nên thứ tự
 * đọc ở đây là bắt buộc, không phải tuỳ ý.
 */
function tokenFromSession(data) {
  if (!data || typeof data !== 'object') return '';
  return String(data.access_token || data.accessToken || '');
}

/** Lý do session KHÔNG dùng được, hoặc '' nếu lành.
 *
 * NextAuth chỉ gắn khoá `error` vào session khi nó không làm mới được token
 * (điển hình là `RefreshAccessTokenError`: refresh token hết hạn hoặc bị thu
 * hồi). Lúc đó payload VẪN có `user` và VẪN có `access_token` — nhưng token ấy
 * là bản cũ đã chết, và phía server mọi route cần xác thực đều trả 401.
 *
 * Đo 2026-09-15 trên máy khách: session có đủ `user`/`access_token`, kèm
 * `error`, và `project.createProject` trả 401 `UNAUTHORIZED` bất kể có đính
 * bearer hay không. Nhận bừa token trong ca này là tệ hơn hỏng thẳng: giao
 * diện báo "token còn 60m", engine nộp request để ăn 401/403, và người dùng
 * đi tìm lỗi ở mọi chỗ trừ chỗ thật.
 *
 * Mắt xích dễ bỏ sót: `labs.google/fx/tools/flow` đã 308 sang flow.google.com
 * nên người dùng không còn ghé trang labs.google nào nữa, phiên NextAuth ở đó
 * mục dần mà không ai thấy. Gỡ bằng cách mở `https://labs.google/fx/` và đăng
 * nhập lại.
 */
function sessionError(data) {
  if (!data || typeof data !== 'object') return '';
  return data.error ? String(data.error) : '';
}

/** Hạn của TOKEN, hoặc null nếu payload không nói.
 *
 * Chỉ nhận trường gắn với token. NextAuth còn có `expires` là hạn của PHIÊN
 * (thường tính bằng ngày); lấy nhầm nó thì giao diện báo token còn tốt trong
 * khi ya29 đã chết từ lâu — đúng cái nhầm lẫn cần tránh nhất ở đây.
 */
function expiryFromSession(data) {
  if (!data || typeof data !== 'object') return null;
  const inSec = Number(data.expires_in);
  if (Number.isFinite(inSec) && inSec > 0) return Date.now() + inSec * 1000;
  const atSec = Number(data.expires_at);
  if (Number.isFinite(atSec) && atSec > 0) return atSec * 1000;
  return null;
}

// Lượt mint đang chạy, dùng chung cho mọi caller trùng nhau. Side panel, alarm
// và nút bấm đều gọi được cùng lúc; giữ promise thì chúng chờ chung một lượt
// thay vì mỗi lượt một request.
let _mintPromise = null;

function mintToken() {
  if (_mintPromise) return _mintPromise;
  _mintPromise = _doMintToken().finally(() => { _mintPromise = null; });
  return _mintPromise;
}

async function _doMintToken() {
  const tried = [];
  let needsLogin = false;
  for (const url of SESSION_URLS) {
    const host = new URL(url).hostname;
    let response;
    try {
      // `credentials: 'include'` để mang cookie đăng nhập của người dùng.
      // `host_permissions` trong manifest đã phủ cả hai domain nên service
      // worker gọi thẳng được, không vướng CORS như gọi từ trong trang.
      response = await fetch(url, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
    } catch (e) {
      tried.push(`${host}=${e.message || 'FETCH_FAILED'}`);
      continue;
    }

    if (!response.ok) {
      tried.push(`${host}=HTTP_${response.status}`);
      continue;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/json/i.test(contentType)) {
      // Đây là SPA fallback, không phải endpoint. Bỏ sớm, đừng phí công đọc
      // 150KB HTML rồi mới vỡ ở JSON.parse.
      tried.push(`${host}=NOT_JSON(${contentType.split(';')[0] || 'none'})`);
      continue;
    }

    let data;
    try {
      data = await response.json();
    } catch (e) {
      tried.push(`${host}=BAD_JSON`);
      continue;
    }

    // Kiểm TRƯỚC khi đọc token: session hỏng vẫn kèm `access_token` cũ, nhận
    // nó là giao cho engine một token chết. Xem `sessionError`.
    const broken = sessionError(data);
    if (broken) {
      tried.push(`${host}=SESSION_ERROR(${broken})`);
      needsLogin = true;
      continue;
    }

    const token = tokenFromSession(data);
    if (!token) {
      // Payload rỗng nghĩa là chưa đăng nhập; có khoá mà không có token nghĩa
      // là Google đã đổi hình dạng. Liệt kê khoá ra để phân biệt được hai ca.
      const keys = Object.keys(data || {}).join(',') || 'empty';
      tried.push(`${host}=NO_TOKEN(${keys})`);
      if (keys === 'empty') needsLogin = true;
      continue;
    }

    adoptToken(token, host, expiryFromSession(data));
    return { ok: true, source: host };
  }

  // Phân biệt "phải đăng nhập lại" với "hỏng kiểu khác": hai ca này người dùng
  // phải làm hai việc hoàn toàn khác nhau, gộp chung thì họ mò mẫm.
  if (needsLogin) {
    return {
      error: `NEEDS_LOGIN [${tried.join(', ')}]`,
      needsLogin: true,
      hint: `Mở ${LOGIN_URL} trong chính cửa sổ Chrome này và đăng nhập lại.`,
    };
  }
  return { error: `TOKEN_NOT_MINTED [${tried.join(', ')}]` };
}

// Còn dưới ngần này thì coi như sắp chết, mint trước khi dùng. Một lượt
// generate mất vài chục giây, cộng captcha và mạng — 3 phút là biên an toàn.
const TOKEN_MIN_TTL_MS = 3 * 60 * 1000;

// Không biết hạn (token bắt được từ header) thì đoán theo tuổi. Token ya29 của
// Flow sống ~60 phút.
const TOKEN_ASSUMED_LIFE_MS = 60 * 60 * 1000;

/** Token còn sống được bao lâu nữa, theo ms. */
function tokenTtlMs() {
  if (!flowKey) return 0;
  if (metrics.tokenExpiresAt) return metrics.tokenExpiresAt - Date.now();
  if (!metrics.tokenCapturedAt) return 0;
  return TOKEN_ASSUMED_LIFE_MS - (Date.now() - metrics.tokenCapturedAt);
}

/** Mint lại nếu token sắp hết hạn. Gọi TRƯỚC mỗi request đi Google.
 *
 * Đây là lớp bảo vệ chính, không phải alarm. Alarm 45 phút nằm trong
 * `ws.onopen`, mà `chrome.alarms.create` trùng tên là THAY THẾ — engine rớt
 * rồi nối lại một lần trong vòng 45 phút là đồng hồ đếm lại từ đầu và alarm
 * không bao giờ nổ. Đo 2026-09-14: token mint lúc đăng nhập, 57 phút sau
 * `uploadImage` trả 401 UNAUTHENTICATED giữa một lượt chạy, trong khi cùng
 * token đó gọi `/v1/credits` vài phút trước vẫn 200.
 */
async function ensureFreshToken() {
  if (tokenTtlMs() > TOKEN_MIN_TTL_MS) return true;
  const minted = await mintToken();
  if (!minted.ok) {
    console.warn('[FlowAgent] Không làm mới được token trước request:', minted.error);
  }
  return !!minted.ok;
}

async function refreshToken() {
  const minted = await mintToken();
  if (minted.ok) {
    console.log('[FlowAgent] Token minted from', minted.source);
  } else {
    console.error('[FlowAgent] Token mint failed:', minted.error);
    if (minted.hint) console.error('[FlowAgent]', minted.hint);
    // Giữ lại để giao diện nói được VIỆC PHẢI LÀM, không chỉ "hỏng".
    metrics.needsLogin = !!minted.needsLogin;
    metrics.lastError = minted.error;
    chrome.storage.local.set({ metrics });
    broadcastStatus();
  }
  return minted;
}

// ─── WebSocket to Agent ─────────────────────────────────────

function connectToAgent() {
  if (manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(bridgeUrl);
  } catch (e) {
    console.error('[FlowAgent] WS connect error:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[FlowAgent] Connected to agent');
    chrome.alarms.clear('reconnect');
    setState('idle');

    // Token refresh alarm — 45 min gives buffer before ~60 min expiry.
    //
    // `chrome.alarms.create` trùng tên là THAY THẾ, tức đếm lại từ đầu. Chỗ này
    // nằm trong `ws.onopen` nên mỗi lần engine rớt rồi nối lại là đồng hồ reset;
    // engine khởi động lại một lần trong 45 phút là alarm không bao giờ nổ và
    // token cứ thế chết giữa lượt chạy. Chỉ tạo khi chưa có.
    chrome.alarms.get('token-refresh', (alarm) => {
      if (!alarm) chrome.alarms.create('token-refresh', { periodInMinutes: 45 });
    });

    // Send readiness metadata only; API requests are authenticated in-extension.
    ws.send(JSON.stringify({
      type: 'extension_ready',
      protocol_version: 3,
      flowKeyPresent: !!flowKey,
      flowKeySource,
      tokenAge: flowKey && metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
    }));
    if (flowKey) {
      ws.send(JSON.stringify({ type: 'token_captured', source: flowKeySource }));
    }
  };

  ws.onmessage = async ({ data }) => {
    try {
      const msg = JSON.parse(data);

      if (msg.method === 'api_request') {
        await handleApiRequest(msg);
      } else if (msg.method === 'trpc_request') {
        await handleTrpcRequest(msg);
      } else if (msg.method === 'batch_rpc') {
        await handleBatchRpc(msg);
      } else if (msg.method === 'solve_captcha') {
        await handleSolveCaptcha(msg);
      } else if (msg.method === 'refresh_token') {
        const minted = await refreshToken();
        sendToAgent({ id: msg.id, result: { ...minted, flowKeyPresent: !!flowKey } });
      } else if (msg.method === 'get_status') {
        sendToAgent({
          id: msg.id,
          result: {
            state,
            flowKeyPresent: !!flowKey,
            manualDisconnect,
            tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
            metrics,
          },
        });
      } else if (msg.type === 'pong') {
        // keepalive response
      }
    } catch (e) {
      console.error('[FlowAgent] Message error:', e);
    }
  };

  ws.onclose = () => {
    setState('off');
    // KHÔNG xoá `token-refresh` ở đây. Xoá lúc đóng rồi tạo lại lúc mở là đúng
    // cái vòng làm đồng hồ 45 phút không bao giờ chạy hết: engine khởi động
    // lại là token hết đường tự làm mới. Giữ alarm chạy độc lập với cầu nối —
    // token là của trình duyệt, không phải của phiên WebSocket.
    if (!manualDisconnect) scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('[FlowAgent] WS error:', e);
    metrics.lastError = 'WS_ERROR';
    chrome.storage.local.set({ metrics });
  };
}

function scheduleReconnect() {
  chrome.alarms.create('reconnect', { delayInMinutes: 0.083 }); // ~5s
}

function keepAlive() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectToAgent();
  }
}

function sendToAgent(msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── reCAPTCHA Solving ──────────────────────────────────────

async function requestCaptchaFromTab(tabId, requestId, pageAction) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    // Inject content script and retry
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await sleep(200);
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  }
}

function _tabHost(url) {
  try { return new URL(url || '').hostname; } catch (e) { return '?'; }
}

/** Xếp tab theo khả năng giải được captcha, tốt nhất lên đầu.
 *
 * `labs.google` được ưu tiên: đó là app thật sự dùng luồng reCAPTCHA này cho
 * REST API mà engine gọi, nên nó nạp `grecaptcha.enterprise` ngay từ đầu. App
 * Angular ở `flow.google.com` nạp lười — đo 2026-09-05: có lúc lấy được token
 * 2404 ký tự, có lúc trả `grecaptcha not available` dù tab vẫn mở.
 *
 * Tab bị Chrome loại khỏi bộ nhớ (`discarded`) thì không có JS nào sống, phải
 * đẩy xuống cuối chứ đừng thử đầu tiên rồi bỏ cuộc.
 */
function _rankFlowTabs(tabs) {
  const score = (tab) => {
    let value = 0;
    if (_tabHost(tab.url).endsWith('labs.google')) value -= 4;
    if (tab.status === 'complete') value -= 2;
    if (tab.active) value -= 1;
    if (tab.discarded) value += 10;
    return value;
  };
  return [...tabs].sort((a, b) => score(a) - score(b));
}

async function _askTabForCaptcha(tab, requestId, captchaAction) {
  return await Promise.race([
    requestCaptchaFromTab(tab.id, requestId, captchaAction),
    new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
  ]);
}

async function solveCaptcha(requestId, captchaAction) {
  let tabs = _rankFlowTabs(await queryFlowTabs());

  if (!tabs.length) {
    try {
      await chrome.tabs.create({ url: FLOW_TAB_URL, active: false });
      await sleep(4000);
      tabs = _rankFlowTabs(await queryFlowTabs());
    } catch (e) {
      return { error: e.message || 'NO_FLOW_TAB' };
    }
    if (!tabs.length) return { error: 'NO_FLOW_TAB' };
  }

  // Thử lần lượt chứ không chết cứng ở `tabs[0]`: một tab không có grecaptcha
  // không có nghĩa là mọi tab đều không có.
  const tried = [];
  for (const tab of tabs.slice(0, 3)) {
    try {
      const resp = await _askTabForCaptcha(tab, requestId, captchaAction);
      if (resp?.token) return resp;
      tried.push(`${_tabHost(tab.url)}=${resp?.error || 'NO_TOKEN'}`);
    } catch (e) {
      tried.push(`${_tabHost(tab.url)}=${e.message || 'ERR'}`);
    }
  }

  // Không tab nào giải được: mở một tab labs.google sạch rồi thử lần cuối.
  try {
    const fresh = await chrome.tabs.create({ url: FLOW_TAB_URL, active: false });
    await sleep(6000);
    const resp = await _askTabForCaptcha(fresh, requestId, captchaAction);
    try { await chrome.tabs.remove(fresh.id); } catch (e) { /* đã đóng */ }
    if (resp?.token) return resp;
    tried.push(`fresh=${resp?.error || 'NO_TOKEN'}`);
  } catch (e) {
    tried.push(`fresh=${e.message || 'ERR'}`);
  }

  // Báo rõ đã thử tab nào: `grecaptcha not available` trơ trọi không đủ để
  // biết extension đang nhìn vào tab nào.
  return { error: `CAPTCHA_FAILED [${tried.join(', ')}]` };
}

async function handleSolveCaptcha(msg) {
  const { id, params } = msg;
  const result = await solveCaptcha(id, params?.captchaAction || 'VIDEO_GENERATION');

  // Standalone captcha solve counts as captcha-consuming
  metrics.requestCount++;
  if (result?.token) {
    metrics.successCount++;
  } else {
    metrics.failedCount++;
    metrics.lastError = result?.error || 'NO_TOKEN';
  }
  chrome.storage.local.set({ metrics });

  sendToAgent({ id, result });
}

// ─── API Request Proxy ──────────────────────────────────────

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body } = params;

  if (!url || !FLOW_TRPC_ORIGINS.some((origin) => url.startsWith(origin))) {
    sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  setState('running');
  // TRPC calls don't consume captcha — don't count in metrics

  const logId = id;
  const logType = url.includes('createProject') ? 'CREATE_PROJECT' : 'TRPC';
  const payloadSummary = body ? JSON.stringify(body).slice(0, 300) : null;
  addRequestLog({
    id: logId,
    type: logType,
    time: new Date().toISOString(),
    status: 'processing',
    error: null,
    url,
    payloadSummary,
  });

  const fetchHeaders = { 'Content-Type': 'application/json', ...headers };
  if (flowKey) {
    fetchHeaders['authorization'] = `Bearer ${flowKey}`;
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const responseText = await resp.text();
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch {
      data = { raw: responseText.slice(0, 1000) };
    }
    const responseSummary = responseText.slice(0, 500) || '<empty>';
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, {
      status: resp.ok ? 'success' : 'failed',
      httpStatus: resp.status,
      responseSummary,
      error: resp.ok ? null : `TRPC_${resp.status}`,
    });
    sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[FlowAgent] tRPC request failed:', e);
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'failed', error: e.message || 'TRPC_FETCH_FAILED' });
    sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  } finally {
    setState('idle');
  }
}

async function handleBatchRpc(msg) {
  const { id, params = {} } = msg;
  const { rpcid, payload } = params;
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(String(rpcid || '')) || !Array.isArray(payload)) {
    sendToAgent({ id, error: 'INVALID_BATCH_RPC' });
    return;
  }

  setState('running');
  const logType = rpcid === 'jHPbke' ? 'CREATE_PROJECT' : 'FLOW_WIRE';
  addRequestLog({
    id,
    type: logType,
    time: new Date().toISOString(),
    status: 'processing',
    error: null,
    url: `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=${rpcid}`,
    payloadSummary: JSON.stringify(payload).slice(0, 12000),
  });

  try {
    const tabs = _rankFlowTabs(await queryFlowTabs()).filter(
      (tab) => _tabHost(tab.url) === 'flow.google.com',
    );
    if (!tabs.length) throw new Error('NO_FLOW_TAB');

    const tried = [];
    for (const tab of tabs.slice(0, 3)) {
      try {
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: 'BATCH_RPC',
          requestId: id,
          rpcid,
          payload,
        });
        if (result?.data !== undefined) {
          updateRequestLog(id, {
            status: 'success',
            httpStatus: result.status || 200,
            responseSummary: JSON.stringify(result.data).slice(0, 12000),
          });
          sendToAgent({ id, status: result.status || 200, data: result.data });
          return;
        }
        tried.push(`${tab.id}=${result?.error || 'EMPTY_RESULT'}`);
      } catch (error) {
        tried.push(`${tab.id}=${error.message || 'TAB_FAILED'}`);
      }
    }
    throw new Error(`BATCH_RPC_FAILED [${tried.join(', ')}]`);
  } catch (error) {
    const message = error.message || 'BATCH_RPC_FAILED';
    updateRequestLog(id, { status: 'failed', error: message });
    sendToAgent({ id, error: message });
  } finally {
    setState('idle');
  }
}

async function handleApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params;

  if (!url) {
    sendToAgent({ id, error: 'MISSING_URL' });
    return;
  }

  if (!url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    sendToAgent({ id, error: 'INVALID_URL' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  const logId = id;
  const logType = _classifyApiUrl(url);
  if (_VISIBLE_TYPES.has(logType)) {
    const payloadSummary = body ? JSON.stringify(body).slice(0, 200) : null;
    addRequestLog({ id: logId, type: logType, time: new Date().toISOString(), status: 'processing', error: null, outputUrl: null, url, payloadSummary });
  }

  try {
    // Step 0: token phải còn sống cho cả lượt. Làm TRƯỚC captcha vì token
    // captcha chỉ sống ~2 phút — mint xong mới giải captcha thì cả hai cùng
    // tươi, còn làm ngược lại thì lượt mint 1-2s đã ăn mất một phần hạn của
    // captcha.
    await ensureFreshToken();

    // Step 1: Solve captcha if needed
    let captchaToken = null;
    if (captchaAction) {
      const captchaResult = await solveCaptcha(id, captchaAction);
      captchaToken = captchaResult?.token || null;
      if (!captchaToken) {
        // Cannot proceed without captcha — API will 403
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        console.error(`[FlowAgent] Captcha failed for ${captchaAction}: ${err}`);
        sendToAgent({ id, status: 403, error: `CAPTCHA_FAILED: ${err}` });
        if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `CAPTCHA_FAILED: ${err}`; }
        chrome.storage.local.set({ metrics });
        updateRequestLog(logId, { status: 'failed', error: `CAPTCHA_FAILED: ${err}` });
        setState('idle');
        return;
      }
    }

    // Step 2: Inject captcha token into body
    let finalBody = body;
    if (captchaToken && finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody)); // deep clone
      if (finalBody.clientContext?.recaptchaContext) {
        finalBody.clientContext.recaptchaContext.token = captchaToken;
      }
      if (finalBody.requests && Array.isArray(finalBody.requests)) {
        for (const req of finalBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = captchaToken;
          }
        }
      }
    }

    // Step 3: Use flowKey for auth
    const activeFlowKey = flowKey;
    if (!activeFlowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'NO_FLOW_KEY'; }
      chrome.storage.local.set({ metrics });
      updateRequestLog(logId, { status: 'failed', error: 'NO_FLOW_KEY' });
      setState('idle');
      return;
    }

    const fetchHeaders = { ...(headers || {}) };
    fetchHeaders['authorization'] = `Bearer ${activeFlowKey}`;

    // Step 4: Make the API call from browser context
    const send = (bearer) => fetch(url, {
      method: method || 'POST',
      headers: { ...fetchHeaders, authorization: `Bearer ${bearer}` },
      credentials: 'include',
      body: method === 'GET' ? undefined : JSON.stringify(finalBody),
    });

    let response = await send(activeFlowKey);

    // Bước 0 đã lo phần lớn, nhưng vẫn còn khe: token có thể chết trong lúc
    // giải captcha, hoặc Google thu hồi sớm. Mint lại rồi thử ĐÚNG MỘT lần.
    //
    // Chỉ thử lại được khi request không ăn captcha: token captcha dùng một
    // lần, nộp lại y nguyên là hỏng. Lượt có captcha thì trả 401 về cho engine
    // — nó đã xếp lớp `AUTH` và biết nộp lại tử tế.
    if (response.status === 401 && !hasCaptcha) {
      console.warn('[FlowAgent] 401 — mint lại token rồi thử lại một lần');
      const minted = await mintToken();
      if (minted.ok && flowKey) {
        response = await send(flowKey);
      }
    }

    let responseData;
    const responseText = await response.text();
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    const responseDebug = summarizeApiResponse(responseData);
    if (logType === 'GEN_VID' || logType === 'GEN_VID_REF') {
      console.info('[FlowAgent] Video submit response', {
        id: String(id).slice(0, 8),
        httpStatus: response.status,
        bytes: responseText.length,
        shape: responseDebug.shape,
        operationIds: responseDebug.operationIds,
      });
    }

    sendToAgent({
      id,
      status: response.status,
      data: responseData,
    });

    const responseSummary = responseText ? responseText.slice(0, 300) : null;
    if (response.ok) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(logId, {
        status: 'success',
        httpStatus: response.status,
        responseSummary,
        responseShape: responseDebug.shape,
        operationIds: responseDebug.operationIds,
      });
    } else {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `API_${response.status}`; }
      updateRequestLog(logId, { status: 'failed', error: `API_${response.status}`, httpStatus: response.status, responseSummary });
    }
  } catch (e) {
    sendToAgent({
      id,
      status: 500,
      error: e.message || 'API_REQUEST_FAILED',
    });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message; }
    updateRequestLog(logId, { status: 'failed', error: e.message || 'API_REQUEST_FAILED' });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

// ─── State & Popup ──────────────────────────────────────────

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors = { idle: '#22c55e', running: '#f59e0b', off: '#6b7280' };
  chrome.action.setBadgeText({ text: badges[state] || '' });
  chrome.action.setBadgeBackgroundColor({ color: colors[state] || '#000' });
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'FLOW_WIRE_DEBUG') {
    const entry = msg.entry || {};
    const logId = `wire-${entry.debugId || Date.now()}`;
    if (entry.phase === 'request') {
      let rpcid = '';
      try { rpcid = new URL(entry.url).searchParams.get('rpcids') || ''; } catch { /* noop */ }
      addRequestLog({
        id: logId,
        type: 'FLOW_WIRE',
        time: new Date().toISOString(),
        status: 'processing',
        error: null,
        url: entry.url,
        payloadSummary: entry.body || '<body unavailable>',
        responseSummary: rpcid ? `rpcids=${rpcid}; transport=${entry.transport}` : `transport=${entry.transport}`,
      });
    } else if (entry.phase === 'request_body') {
      updateRequestLog(logId, { payloadSummary: entry.body || '<empty>' });
    } else if (entry.phase === 'response') {
      updateRequestLog(logId, {
        status: Number(entry.status) >= 200 && Number(entry.status) < 400 ? 'success' : 'failed',
        httpStatus: entry.status,
        responseSummary: entry.body || '<empty>',
        error: entry.error || (Number(entry.status) >= 400 ? `FLOW_WIRE_${entry.status}` : null),
      });
    }
    return;
  }

  if (msg.type === 'STATUS') {
    reply({
      connected: ws?.readyState === WebSocket.OPEN,
      agentConnected: ws?.readyState === WebSocket.OPEN,
      flowKeyPresent: !!flowKey,
      manualDisconnect,
      tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      // Còn sống bao lâu nữa, theo hạn endpoint trả về. null = nguồn không nói,
      // giao diện phải quay lại đoán theo tuổi.
      tokenTtl: metrics.tokenExpiresAt ? metrics.tokenExpiresAt - Date.now() : null,
      // Phiên NextAuth ở labs.google hỏng: token có thể vẫn còn trong storage
      // nhưng đã chết, mọi request sẽ 401. Người dùng phải đăng nhập lại.
      needsLogin: !!metrics.needsLogin,
      loginUrl: LOGIN_URL,
      metrics: {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failedCount: metrics.failedCount,
        lastError: metrics.lastError,
      },
      state,
    });
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnect = true;
    chrome.storage.local.set({ manualDisconnect: true });
    if (ws) ws.close();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    manualDisconnect = false;
    chrome.storage.local.set({ manualDisconnect: false });
    connectToAgent();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'BRIDGE_URL_CHANGED') {
    const nextUrl = String(msg.bridgeUrl || '');
    if (!/^ws:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(nextUrl)) {
      reply({ error: 'Bridge URL must be a loopback ws:// URL with a port' });
      return true;
    }
    bridgeUrl = nextUrl;
    if (ws) ws.close();
    ws = null;
    connectToAgent();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'REQUEST_LOG') {
    reply({ log: requestLog });
    return true;
  }

  if (msg.type === 'ARM_FLOW_CREATE_DEBUG') {
    requestLog = requestLog.filter((entry) => entry.type !== 'FLOW_WIRE');
    broadcastRequestLog();
    queryFlowTabs().then(async (tabs) => {
      const attempts = await Promise.allSettled(tabs.map((tab) => (
        chrome.tabs.sendMessage(tab.id, {
          type: 'ARM_FLOW_WIRE_DEBUG',
          durationMs: 60000,
        })
      )));
      const armedTabs = attempts.filter((item) => item.status === 'fulfilled').length;
      reply(armedTabs
        ? { ok: true, armedTabs }
        : { error: 'Không có tab Flow nào nhận được lệnh capture; hãy reload tab Flow.' });
    }).catch((error) => reply({ error: error.message }));
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    queryFlowTabs().then((tabs) => {
      if (tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true });
        reply({ ok: true, tabId: tabs[0].id });
      } else {
        chrome.tabs.create({ url: FLOW_TAB_URL })
          .then((tab) => reply({ ok: true, tabId: tab.id }))
          .catch((e) => reply({ error: e.message }));
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'OPEN_LOGIN') {
    // KHÔNG mở `FLOW_TAB_URL`: nó 308 sang flow.google.com nên không chạm vào
    // labs.google, và phiên cần gia hạn nằm ở labs.google.
    chrome.tabs.create({ url: LOGIN_URL })
      .then((tab) => reply({ ok: true, tabId: tab.id }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    refreshToken()
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TEST_CAPTCHA') {
    solveCaptcha(`test-${Date.now()}`, msg.pageAction || 'IMAGE_GENERATION')
      .then((r) => reply(r))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  return true;
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

init().catch((error) => console.error('[FlowAgent] Initialization failed:', error));

console.log('[FlowAgent] Extension loaded');
