(() => {
  const DS_MATCH = '*://chat.deepseek.com/*';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let activeTabId = null;
  const popupPorts = new Set();

  // 安装/更新扩展时，刷新已打开的 DeepSeek 标签页，让内容脚本重新注入
  chrome.runtime.onInstalled.addListener(async () => {
    try {
      const tabs = await chrome.tabs.query({ url: DS_MATCH });
      for (const t of tabs) chrome.tabs.reload(t.id).catch(() => {});
    } catch (e) {}
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'ds-popup') return;
    popupPorts.add(port);
    port.onDisconnect.addListener(() => popupPorts.delete(port));

    // 关键：弹窗通过 port 发送命令，必须在 port 上监听
    port.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'popup-cmd') return;
      handlePopupCmd(msg)
        .then((result) => {
          try { port.postMessage({ type: 'cmd-result', reqId: msg.reqId, result }); } catch (e) {}
        })
        .catch((e) => {
          try {
            port.postMessage({ type: 'cmd-result', reqId: msg.reqId, result: { error: String((e && e.message) || e) } });
          } catch (e2) {}
        });
    });
  });

  function toPopup(msg) {
    for (const p of popupPorts) {
      try { p.postMessage(msg); } catch (e) {}
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ds-event') {
      // 只转发当前管理的那个 DeepSeek 标签页的事件
      if (activeTabId && sender.tab && sender.tab.id !== activeTabId) return;
      toPopup({ type: 'event', payload: msg.payload });
      return;
    }
    if (msg.type === 'popup-cmd') {
      // 兼容 sendMessage 方式发来的命令
      handlePopupCmd(msg)
        .then((result) => {
          toPopup({ type: 'cmd-result', reqId: msg.reqId, result });
        })
        .catch((e) => {
          toPopup({ type: 'cmd-result', reqId: msg.reqId, result: { error: String((e && e.message) || e) } });
        });
      return true;
    }
  });

  async function getDsTab() {
    const tabs = await chrome.tabs.query({ url: DS_MATCH });
    return tabs.length ? tabs[tabs.length - 1] : null;
  }

  async function ensureTab() {
    let tab = await getDsTab();
    if (!tab) {
      try {
        tab = await chrome.tabs.create({ url: 'https://chat.deepseek.com/', active: true });
      } catch (e) {
        tab = await getDsTab();
        if (!tab) throw new Error('无法打开 DeepSeek 标签页：' + ((e && e.message) || e));
      }
    }
    activeTabId = tab.id;
    return tab;
  }

  // 向页面脚本发命令并等待回应（用 reqId 关联）
  function relayCmd(tabId, cmd, args, timeoutMs) {
    return new Promise((resolve) => {
      const reqId = 'q' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs || 2000);
      const listener = (m) => {
        if (m && m.type === 'ds-event' && m.payload && m.payload.reqId === reqId) {
          cleanup();
          resolve(m.payload);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
      };
      chrome.runtime.onMessage.addListener(listener);
      chrome.tabs.sendMessage(tabId, { type: 'ds-cmd', cmd, args: Object.assign({}, args || {}, { reqId }) }).catch(() => {});
    });
  }

  // 标签页可能早于扩展安装就已打开，或脚本被浏览器休眠，这里补注入
  async function injectScripts(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/relay.js'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/bridge.js'], world: 'MAIN' });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function waitTabComplete(tabId, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t && t.status === 'complete') return true;
      } catch (e) { return false; }
      await sleep(300);
    }
    return false;
  }

  // 确保页面脚本可用：等加载完成 -> 探测 -> 补注入 -> 刷新页面
  async function ensureBridge(tabId) {
    await waitTabComplete(tabId, 8000);
    let p = await relayCmd(tabId, 'status', {}, 1500);
    if (p && p.status) return p.status;

    await injectScripts(tabId);
    p = await relayCmd(tabId, 'status', {}, 1500);
    if (p && p.status) return p.status;

    try { await chrome.tabs.reload(tabId); } catch (e) {}
    await sleep(1500);
    for (let i = 0; i < 6; i++) {
      p = await relayCmd(tabId, 'status', {}, 800);
      if (p && p.status) return p.status;
      await sleep(300);
    }
    return null;
  }

  async function handlePopupCmd(msg) {
    const cmd = msg.cmd;
    const args = msg.args || {};

    if (cmd === 'ensure-tab') {
      const tab = await ensureTab();
      const status = await ensureBridge(tab.id);
      return { tabId: tab.id, status, reason: status ? null : 'bridge-unreachable' };
    }

    if (cmd === 'status') {
      if (!activeTabId) await ensureTab();
      // 轻量探测，避免每次轮询都触发注入/刷新
      const p = await relayCmd(activeTabId, 'status', {}, 1500);
      return p && p.status ? p.status : null;
    }

    const tab = activeTabId ? { id: activeTabId } : await getDsTab();
    if (!tab) return null;
    chrome.tabs.sendMessage(tab.id, { type: 'ds-cmd', cmd, args }).catch(() => {});
    return { ok: true };
  }
})();
