(() => {
  if (window.__dsBridgeInstalled) return;
  window.__dsBridgeInstalled = true;

  const OUT = 'ds-bridge-out';
  const IN = 'ds-relay-in';
  const STREAM_RE = /\/api\/v0\/chat\/(completion|regenerate|continue|edit_message|resume_stream)/;

  const state = {
    pendingAskId: null,   // 插件发起、等待 App 发出请求的 askId
    activeXhr: null,      // 当前流式 XHR（用于停止）
    activeAbort: null,    // 当前流式 fetch 的取消函数
    stream: null,         // 当前流状态快照的数据源
  };

  const emit = (payload) => window.postMessage({ source: OUT, payload }, '*');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- 状态快照 ---------------- */

  function snapshot(s) {
    let text = '', thinking = '', searching = 0;
    for (const idx of s.order) {
      const f = s.fragments.get(idx);
      const t = String(f.type || '').toUpperCase();
      if (t === 'SEARCH') { searching++; continue; }
      if (t.indexOf('THINK') >= 0) thinking += f.text;
      else text += f.text;
    }
    return {
      askId: s.askId, prompt: s.prompt, kind: s.kind,
      text, thinking, searching,
      dbg: (s.done && text.length < 4) ? String(s.dbg || '').slice(0, 1200) : '',
      done: !!s.done, stopped: !!s.stopped, error: s.error || null,
    };
  }

  function statusInfo() {
    return {
      loggedIn: !location.pathname.startsWith('/sign_in'),
      url: location.href,
      hasComposer: !!findComposer(),
      stream: state.stream ? snapshot(state.stream) : null,
    };
  }

  /* ---------------- SSE 解析 ----------------
     DeepSeek 网页版流式协议：标准 SSE 行（event:/data:），
     data 为 JSON-patch 增量 {op:"SET"|"APPEND", path:"/response/fragments/i/content", value} */

  // 每条流独立一份解析状态，避免并发流互相污染
  function createSSEParser(onData) {
    let pending = '', evt = '', data = '';
    return function push(chunk) {
      pending += chunk;
      let idx;
      while ((idx = pending.indexOf('\n')) >= 0) {
        let line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data) { try { onData(data, evt); } catch (e) {} }
          evt = ''; data = '';
        } else if (line.indexOf('event:') === 0) {
          evt = line.slice(6).trim();
        } else if (line.indexOf('data:') === 0) {
          data += (data ? '\n' : '') + line.slice(5).trim();
        }
      }
    };
  }

  function parseMaybe(o) {
    if (typeof o !== 'string') return o;
    const s = o.trim();
    if (!s || (s.charAt(0) !== '{' && s.charAt(0) !== '[')) return o;
    try { return JSON.parse(s); } catch (e) { return o; }
  }

  // 按结构匹配增量对象：长键 op/path/value 或短键 o/p/v（op 可能是数字枚举）
  function findDelta(o, depth) {
    if (!o || typeof o !== 'object' || depth > 6) return null;
    if ('p' in o && 'v' in o) {
      return { op: String(o.o != null ? o.o : ''), path: Array.isArray(o.p) ? o.p.join('/') : String(o.p), value: o.v };
    }
    if ('path' in o && 'value' in o) {
      return { op: String(o.op != null ? o.op : ''), path: Array.isArray(o.path) ? o.path.join('/') : String(o.path), value: o.value };
    }
    for (const k in o) {
      const r = findDelta(parseMaybe(o[k]), depth + 1);
      if (r) return r;
    }
    return null;
  }

  function ensureFrag(stream, idx) {
    if (!stream.fragments.has(idx)) {
      stream.fragments.set(idx, { text: '', type: '' });
      stream.order.push(idx);
    }
    return stream.fragments.get(idx);
  }

  function applyDelta(stream, dataStr) {
    let json;
    try { json = JSON.parse(dataStr); } catch (e) { return; }
    const d = findDelta(json, 0);

    if (d) {
      const seg = typeof d.path === 'string' ? d.path.split('/').filter(Boolean) : [];
      const fi = seg.indexOf('fragments');
      if (fi >= 0) {
        const idx = String(seg[fi + 1] != null ? seg[fi + 1] : 0);
        const field = seg[fi + 2];
        const frag = ensureFrag(stream, idx);
        if (field === 'type' && typeof d.value === 'string') {
          frag.type = d.value;
        } else if (field == null || field === 'content' || field === 'text') {
          applyContent(frag, d.value);
          stream.curIdx = idx;
        }
        return;
      }
      initFromSnapshot(stream, d.value);
      return;
    }

    if (!json || typeof json !== 'object') return;
    // 隐式增量：只有 {"v":"文本"}，续写上一个内容片段
    if (typeof json.v === 'string') {
      const frag = ensureFrag(stream, stream.curIdx != null ? stream.curIdx : '0');
      applyContent(frag, json.v);
      return;
    }
    // 整包快照：{"v":{"response":{...,"fragments":[...]}}}
    if (json.v && typeof json.v === 'object') {
      initFromSnapshot(stream, json.v);
      return;
    }
    initFromSnapshot(stream, json);
  }

  function initFromSnapshot(stream, obj) {
    const resp = obj && obj.response ? obj.response : obj;
    const arr = resp && Array.isArray(resp.fragments) ? resp.fragments : null;
    if (!arr) return false;
    arr.forEach((f, i) => {
      const frag = ensureFrag(stream, String(i));
      if (f && typeof f === 'object') {
        if (typeof f.type === 'string') frag.type = f.type;
        applyContent(frag, f.content);
      }
    });
    return true;
  }

  // 同时兼容“累积快照”（值以上一段开头）与“增量片段”（追加）
  function applyContent(frag, v) {
    if (typeof v === 'string') {
      if (frag.text && v.length >= frag.text.length && v.indexOf(frag.text) === 0) frag.text = v;
      else frag.text += v;
    } else if (v && typeof v === 'object') {
      if (typeof v.type === 'string') frag.type = v.type;
      if (typeof v.content === 'string') applyContent(frag, v.content);
    }
  }

  function readPrompt(body) {
    try {
      const j = JSON.parse(body);
      return j && typeof j.prompt === 'string' ? j.prompt : null;
    } catch (e) { return null; }
  }

  function newStream(askId, prompt, kind) {
    return {
      askId: askId || null, prompt: prompt || null, kind: kind || 'completion',
      fragments: new Map(), order: [], dbg: '', curIdx: null,
      done: false, stopped: false, error: null,
    };
  }

  function beginStream(stream) {
    state.stream = stream;
    if (stream.askId) state.pendingAskId = null;
    emit({ type: 'stream-start', stream: snapshot(stream) });
  }

  function describeDelta(dataStr) {
    let json;
    try { json = JSON.parse(dataStr); } catch (e) { return 'RAW ' + dataStr.slice(0, 100); }
    const d = findDelta(json, 0);
    if (!d) {
      if (typeof json.v === 'string') return 'IMPLICIT ' + JSON.stringify(json.v.slice(0, 40));
      if (json.v && typeof json.v === 'object') return 'SNAPSHOT';
      return 'OTHER keys=' + Object.keys(json || {}).join(',');
    }
    const v = d.value;
    let pv;
    if (typeof v === 'string') pv = JSON.stringify(v.slice(0, 40));
    else if (Array.isArray(v)) pv = 'array(' + v.length + ')';
    else if (v && typeof v === 'object') pv = 'obj{' + Object.keys(v).join(',') + '}';
    else pv = String(v);
    return d.op + ' ' + d.path + ' = ' + pv;
  }

  function onDelta(stream, dataStr) {
    if (stream.dbg.length < 2000) stream.dbg += describeDelta(dataStr) + '\n';
    applyDelta(stream, dataStr);
    emit({ type: 'stream-delta', askId: stream.askId, stream: snapshot(stream) });
  }

  function endStream(stream, err) {
    if (stream.done) return;
    stream.done = true;
    stream.endedAt = Date.now();
    if (err) stream.error = err;
    if (state.activeXhr || state.activeAbort) { state.activeXhr = null; state.activeAbort = null; }
    emit({ type: 'stream-end', stream: snapshot(stream) });
  }

  /* ---------------- 拦截 XHR（App 的实际传输方式） ---------------- */

  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  const oHdr = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ds = { method: String(method || '').toUpperCase(), url: String(url || '') };
    return oOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__ds) this.__ds.headers = this.__ds.headers || {};
    return oHdr.call(this, k, v);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__ds;
    if (meta && meta.method === 'POST' && STREAM_RE.test(meta.url)) {
      captureXhr(this, meta, typeof body === 'string' ? body : '');
    }
    return oSend.call(this, body);
  };

  function captureXhr(xhr, meta, body) {
    const kind = (meta.url.match(STREAM_RE) || [])[1] || 'completion';
    const prev = state.stream;
    // 续流(resume_stream)接到当前回答上，避免一条回答被拆成两个气泡
    const reuse = (kind === 'resume_stream' && prev && (!prev.done || Date.now() - (prev.endedAt || 0) < 8000)) ? prev : null;
    const stream = reuse || newStream(state.pendingAskId, readPrompt(body), kind);
    state.activeXhr = xhr;
    if (reuse) {
      reuse.done = false;
      reuse.error = null;
      emit({ type: 'stream-delta', askId: reuse.askId, stream: snapshot(reuse) });
    } else {
      beginStream(stream);
    }

    let buf = '';
    let byteRead = 0;
    const push = createSSEParser((data) => onDelta(stream, data));
    let lastAt = Date.now();
    const watchdog = setInterval(() => {
      if (stream.done || state.stream !== stream) { clearInterval(watchdog); return; }
      if (Date.now() - lastAt > 25000) { clearInterval(watchdog); endStream(stream, null); }
    }, 3000);

    const feed = () => {
      lastAt = Date.now();
      let txt = null;
      try { txt = xhr.responseText; } catch (e) { txt = null; }
      // responseType 为 arraybuffer/blob 时 responseText 不可用，按字节累积解码
      if (typeof txt !== 'string') {
        if (xhr.response instanceof ArrayBuffer && xhr.response.byteLength > byteRead) {
          const bytes = new Uint8Array(xhr.response);
          const chunk = new TextDecoder().decode(bytes.slice(byteRead));
          byteRead = bytes.length;
          if (chunk) push(chunk);
        }
        return;
      }
      if (txt.length <= buf.length) return;
      push(txt.slice(buf.length));
      buf = txt;
    };
    xhr.addEventListener('progress', feed);
    xhr.addEventListener('load', feed);
    xhr.addEventListener('loadend', () => {
      clearInterval(watchdog);
      if (xhr.status && (xhr.status < 200 || xhr.status >= 300)) {
        endStream(stream, 'HTTP ' + xhr.status);
      } else {
        endStream(stream, null);
      }
    });
    xhr.addEventListener('abort', () => { stream.stopped = true; endStream(stream, null); });
    xhr.addEventListener('error', () => endStream(stream, '网络错误'));
    xhr.addEventListener('timeout', () => endStream(stream, '请求超时'));
  }

  /* ---------------- 拦截 fetch（兜底，部分流程可能走 fetch） ---------------- */

  const oFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0];
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const init = args[1] || {};
    const resp = await oFetch.apply(this, args);
    try {
      const method = String(init.method || 'GET').toUpperCase();
      if (method === 'POST' && STREAM_RE.test(url)) {
        const stream = newStream(state.pendingAskId, readPrompt(typeof init.body === 'string' ? init.body : ''), (url.match(STREAM_RE) || [])[1]);
        state.activeAbort = () => { try { resp.body && resp.body.cancel(); } catch (e) {} };
        beginStream(stream);
        const reader = resp.clone().body.getReader();
        const dec = new TextDecoder();
        const push = createSSEParser((data) => onDelta(stream, data));
        (async () => {
          try {
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              push(dec.decode(r.value, { stream: true }));
            }
          } catch (e) { stream.stopped = true; }
          endStream(stream, resp.ok ? null : 'HTTP ' + resp.status);
        })();
      }
    } catch (e) {}
    return resp;
  };

  /* ---------------- 触发页面发送 ---------------- */

  function findComposer() {
    const els = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]'));
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      if (el.offsetParent !== null && !el.disabled && !el.readOnly) return el;
    }
    return null;
  }

  function setComposerText(el, text) {
    el.focus();
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      try { document.execCommand('selectAll', false, null); } catch (e) {}
      document.execCommand('insertText', false, text);
    }
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function findSendButton(el) {
    const byLabel = Array.from(document.querySelectorAll('button[aria-label], button[title], [role="button"][aria-label]'))
      .filter((b) => {
        const l = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
        return /发送|send/i.test(l) && b.offsetParent !== null;
      });
    if (byLabel.length) return byLabel[byLabel.length - 1];
    let node = el.parentElement;
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      const btns = Array.from(node.querySelectorAll('button')).filter((b) => b.offsetParent !== null && !b.disabled);
      if (btns.length) return btns[btns.length - 1];
    }
    return null;
  }

  async function waitStreamStart(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (state.stream && !state.stream.done && state.stream.askId) return true;
      await sleep(80);
    }
    return false;
  }

  /* ---------------- 图片附件：交给页面自身的上传逻辑 ---------------- */

  function b64ToFile(f) {
    try {
      const bin = atob(f.data || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], f.name || 'image.png', { type: f.type || 'image/png' });
    } catch (e) { return null; }
  }

  function findFileInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (!inputs.length) return null;
    const img = inputs.filter((i) => !i.accept || /image/i.test(i.accept));
    return img.length ? img[img.length - 1] : inputs[inputs.length - 1];
  }

  function hasUploadChip() {
    const el = findComposer();
    if (!el) return false;
    let node = el.parentElement;
    for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
      if (node.querySelector('img')) return true;
    }
    return false;
  }

  async function attachFiles(files) {
    const list = files.map(b64ToFile).filter(Boolean);
    if (!list.length) return false;
    const dt = new DataTransfer();
    list.forEach((f) => dt.items.add(f));

    const input = findFileInput();
    if (input) {
      try {
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) { return false; }
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        await sleep(300);
        if (!input.files || input.files.length === 0) { await sleep(500); return true; }
        if (Date.now() - t0 > 1500 && hasUploadChip()) { await sleep(600); return true; }
      }
      return true;
    }

    // 退化方案：直接向输入框派发 paste 事件
    const el = findComposer();
    if (!el) return false;
    try {
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      el.dispatchEvent(ev);
    } catch (e) { return false; }
    await sleep(2500);
    return true;
  }

  async function cmdAsk(args) {
    let prompt = (args && args.prompt || '').trim();
    const files = (args && args.files) || [];
    const askId = (args && args.askId) || 'a' + Date.now().toString(36);
    if (!prompt && !files.length) { emit({ type: 'ask-error', askId, error: '问题不能为空' }); return; }
    if (files.length) {
      const ok = await attachFiles(files);
      if (!ok) {
        emit({ type: 'ask-error', askId, error: '图片附加失败（页面结构可能已变化），可改在网页版里手动上传' });
        return;
      }
      if (!prompt) prompt = '请看这张图片';
    }
    const el = findComposer();
    if (!el) {
      emit({ type: 'ask-error', askId, error: '未找到聊天输入框，请确认当前标签页是 DeepSeek 聊天页且已登录' });
      return;
    }
    const composerHasText = () => {
      try {
        const cur = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.textContent;
        return String(cur || '').trim().length > 0;
      } catch (e) { return true; }
    };

    state.pendingAskId = askId;
    setComposerText(el, prompt);
    pressEnter(el);
    if (await waitStreamStart(1200)) return;
    // 回车没生效（输入框内容还在）时才点发送按钮，避免重复发送
    if (composerHasText()) {
      const btn = findSendButton(el);
      if (btn) {
        btn.click();
        if (await waitStreamStart(2500)) return;
      }
    } else if (await waitStreamStart(2500)) {
      return;
    }
    state.pendingAskId = null;
    emit({ type: 'ask-error', askId, error: '自动发送失败（页面结构可能已变化）。请手动点击页面上的发送按钮，回答仍会同步到插件。' });
  }

  function cmdStop() {
    if (state.activeXhr) { try { state.activeXhr.abort(); } catch (e) {} }
    if (state.activeAbort) { try { state.activeAbort(); } catch (e) {} }
  }

  function cmdNewChat() {
    const btn = Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => {
      const l = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
      return /新对话|new chat/i.test(l) && b.offsetParent !== null;
    });
    if (btn) btn.click();
    state.stream = null;
    emit({ type: 'new-chat', clicked: !!btn });
  }

  /* ---------------- 命令入口 ---------------- */

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== IN) return;
    const cmd = e.data.cmd;
    const args = e.data.args || {};
    try {
      if (cmd === 'ask') cmdAsk(args);
      else if (cmd === 'stop') cmdStop();
      else if (cmd === 'newChat') cmdNewChat();
      else if (cmd === 'status') emit({ type: 'status', reqId: args.reqId, status: statusInfo() });
    } catch (err) {
      emit({ type: 'ask-error', askId: args.askId, error: String((err && err.message) || err) });
    }
  });
})();
