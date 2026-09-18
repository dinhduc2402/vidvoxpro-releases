const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:9222';
const input = document.querySelector('#bridge-url');
const status = document.querySelector('#status');

chrome.storage.local.get(['bridgeUrl']).then((data) => {
  input.value = data.bridgeUrl || DEFAULT_BRIDGE_URL;
});

document.querySelector('#save').addEventListener('click', async () => {
  const bridgeUrl = input.value.trim();
  if (!/^ws:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(bridgeUrl)) {
    status.textContent = 'Use ws://127.0.0.1:<port> or ws://localhost:<port>.';
    status.className = 'err';
    return;
  }
  await chrome.storage.local.set({ bridgeUrl });
  const result = await chrome.runtime.sendMessage({
    type: 'BRIDGE_URL_CHANGED',
    bridgeUrl,
  });
  if (result?.ok) {
    status.textContent = 'Saved.';
    status.className = 'ok';
  } else {
    status.textContent = result?.error || 'Could not reconnect.';
    status.className = 'err';
  }
});
