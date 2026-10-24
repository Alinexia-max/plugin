(() => {
  if (window.__dsRelayInstalled) return;
  window.__dsRelayInstalled = true;

  const OUT = 'ds-bridge-out';
  const IN = 'ds-relay-in';

  // 页面主世界(bridge) -> 隔离世界(本脚本) -> background
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== OUT) return;
    try {
      chrome.runtime.sendMessage({ type: 'ds-event', payload: e.data.payload });
    } catch (err) {}
  });

  // background -> 隔离世界 -> 页面主世界(bridge)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ds-cmd') {
      window.postMessage({ source: IN, cmd: msg.cmd, args: msg.args || {} }, '*');
    }
  });
})();
