chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openPopup') {
    chrome.action.openPopup().catch(() => {});
    return;
  }

  // Fetch any URL from the service worker — bypasses CORS restrictions
  // Used to fetch GitHub Actions job logs which redirect to external storage
  if (message.action === 'fetchText') {
    fetch(message.url, { headers: message.headers || {} })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(text => sendResponse({ ok: true, text }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // keep channel open for async response
  }
});
