(() => {
  const $ = (id) => document.getElementById(id);
  const chat = $('chat');
  const input = $('input');
  const banner = $('banner');
  const conn = $('conn');
  const connText = $('conn-text');
  const btnSend = $('btn-send');
  const btnStop = $('btn-stop');
  const btnNew = $('btn-new');
  const btnOpen = $('btn-open');

  const state = {
    port: null,
    askId: null,
    assistant: null,   // { askId, el, bodyEl, thinkEl, searchEl, text, thinking }
    lastUserText: '',
    reqSeq: 0,
    pending: new Map(),
    bannerKind: null,  // null | 'nopage' | 'login'
    connected: false,
    files: [],         // 待发送图片 [{name,type,url,data}]
  };

  /* ---------------- markdown 渲染 ---------------- */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdown(src) {
    if (!src) return '';
    const codeBlocks = [];
    let text = String(src).replace(/```([\w+-]*)\r?\n?([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
      codeBlocks.push('<pre><code>' + escapeHtml(code.replace(/\r?\n$/, '')) + '</code></pre>');
      return '\u0000C' + (codeBlocks.length - 1) + '\u0000';
    });

    const inline = (s) => {
      s = escapeHtml(s);
      s = s.replace(/`([^`\n]+)`/g, (m, c) => '<code>' + c + '</code>');
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
      s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
      return s;
    };

    const lines = text.split('\n');
    const out = [];
    let para = [], list = null, quote = null;
    const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
    const flushList = () => {
      if (list) {
        out.push('<' + list.tag + '>' + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + '</' + list.tag + '>');
        list = null;
      }
    };
    const flushQuote = () => { if (quote) { out.push('<blockquote>' + quote.map(inline).join('<br>') + '</blockquote>'); quote = null; } };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      const trimmed = line.trim();
      if (/^\u0000C\d+\u0000$/.test(trimmed)) { flushAll(); out.push(trimmed); continue; }
      if (!trimmed) { flushAll(); continue; }
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        flushAll();
        const lv = m[1].length;
        out.push('<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>');
        continue;
      }
      if (/^(\s*[-*_]\s*){3,}$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara(); flushQuote();
        if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
        list.items.push(m[1]);
        continue;
      }
      if ((m = line.match(/^\s*\d+[.、]\s*(.*)$/))) {
        flushPara(); flushQuote();
        if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
        list.items.push(m[1]);
        continue;
      }
      if ((m = line.match(/^>\s?(.*)$/))) {
        flushPara(); flushList();
        quote = quote || [];
        quote.push(m[1]);
        continue;
      }
      flushList(); flushQuote();
      para.push(line);
    }
    flushAll();
    return out.join('\n').replace(/\u0000C(\d+)\u0000/g, (m, i) => codeBlocks[+i]);
  }

  /* ---------------- 消息渲染 ---------------- */

  function scrollBottom() {
    chat.scrollTop = chat.scrollHeight;
  }

  function addUserMsg(text, files) {
    state.lastUserText = text;
    const el = document.createElement('div');
    el.className = 'msg user';
    if (files && files.length) {
      const box = document.createElement('div');
      box.className = 'msg-imgs';
      files.forEach((f) => {
        const img = document.createElement('img');
        img.src = f.url;
        img.alt = f.name || 'image';
        box.appendChild(img);
      });
      el.appendChild(box);
    }
    if (text) {
      const t = document.createElement('div');
      t.className = 'msg-text';
      t.textContent = text;
      el.appendChild(t);
    }
    chat.appendChild(el);
    scrollBottom();
  }

  function addSystemMsg(text) {
    const el = document.createElement('div');
    el.className = 'msg system';
    el.textContent = text;
    chat.appendChild(el);
    scrollBottom();
  }

  function addErrorMsg(text) {
    const el = document.createElement('div');
    el.className = 'msg error';
    el.textContent = text;
    chat.appendChild(el);
    scrollBottom();
  }

  function startAssistant(askId) {
    const cur = state.assistant;
    // 同一提问复用气泡；无 askId 的续流继续写在上一段回答里
    if (cur && (cur.askId === askId || askId == null)) return cur;
    const el = document.createElement('div');
    el.className = 'msg assistant';
    const think = document.createElement('details');
    think.className = 'think hidden';
    const summary = document.createElement('summary');
    summary.textContent = '深度思考';
    const thinkBody = document.createElement('div');
    think.appendChild(summary);
    think.appendChild(thinkBody);
    const search = document.createElement('div');
    search.className = 'searching hidden';
    const body = document.createElement('div');
    body.className = 'md';
    const dbg = document.createElement('details');
    dbg.className = 'dbg hidden';
    const dbgSum = document.createElement('summary');
    dbgSum.textContent = '原始数据（排查用）';
    const dbgPre = document.createElement('pre');
    dbg.appendChild(dbgSum);
    dbg.appendChild(dbgPre);
    el.appendChild(search);
    el.appendChild(think);
    el.appendChild(body);
    el.appendChild(dbg);
    chat.appendChild(el);
    state.assistant = { askId, el, body, think, thinkBody, search, dbg, dbgPre, raw: '', text: '', thinking: '' };
    scrollBottom();
    return state.assistant;
  }

  function updateAssistant(s) {
    const a = startAssistant(s.askId);
    if (s.thinking) {
      a.think.classList.remove('hidden');
      if (a.thinking !== s.thinking) {
        a.thinking = s.thinking;
        a.thinkBody.innerHTML = renderMarkdown(s.thinking);
      }
    }
    if (s.searching && !s.done) {
      a.search.classList.remove('hidden');
      a.search.textContent = '正在深度搜索…';
    } else {
      a.search.classList.add('hidden');
    }
    if (a.text !== s.text) {
      a.text = s.text;
      a.body.innerHTML = renderMarkdown(s.text) + (s.done ? '' : '<span class="cursor"></span>');
    }
    if (s.dbg && s.dbg !== a.dbgText) {
      a.dbgText = s.dbg;
      a.dbg.classList.remove('hidden');
      a.dbgPre.textContent = s.dbg;
    }
    scrollBottom();
  }

  function finishAssistant(s) {
    const a = startAssistant(s.askId);
    updateAssistant(Object.assign({}, s, { done: true }));
    if (s.error) addErrorMsg('出错了：' + s.error);
    else if (s.stopped) addSystemMsg('已停止生成');
    else if (!s.text && !s.thinking) {
      addSystemMsg('未解析到回答内容' + (s.dbg ? '。增量：' + s.dbg.slice(0, 300) : '（未收到数据流）'));
    }
    state.askId = null;
    setGenerating(false);
  }

  function clearChat() {
    chat.innerHTML = '';
    state.assistant = null;
    state.askId = null;
    setGenerating(false);
  }

  /* ---------------- 连接与命令 ---------------- */

  function connect() {
    try {
      state.port = chrome.runtime.connect({ name: 'ds-popup' });
    } catch (e) {
      state.port = null;
      conn.className = 'conn bad';
      connText.textContent = '后台未就绪';
      return;
    }
    const port = state.port;
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      state.pending.forEach((r) => r(null));
      state.pending.clear();
      setTimeout(() => { if (state.port === port) connect(); }, 300);
    });
  }

  function sendCmd(cmd, args) {
    return new Promise((resolve) => {
      if (!state.port) connect();
      if (!state.port) { resolve(null); return; }
      const reqId = 'r' + (++state.reqSeq);
      state.pending.set(reqId, resolve);
      try {
        state.port.postMessage({ type: 'popup-cmd', reqId, cmd, args: args || {} });
      } catch (e) {
        state.pending.delete(reqId);
        resolve(null);
        return;
      }
      setTimeout(() => {
        if (state.pending.delete(reqId)) resolve(null);
      }, 20000);
    });
  }

  function onPortMessage(msg) {
    if (!msg) return;
    if (msg.type === 'cmd-result') {
      const r = state.pending.get(msg.reqId);
      if (r) {
        state.pending.delete(msg.reqId);
        r(msg.result);
      }
      return;
    }
    if (msg.type === 'event') handleEvent(msg.payload);
  }

  function setGenerating(on) {
    btnSend.classList.toggle('hidden', on);
    btnStop.classList.toggle('hidden', !on);
  }

  function showBanner(kind, text, actions) {
    state.bannerKind = kind;
    banner.className = 'banner';
    banner.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = text;
    const box = document.createElement('div');
    box.className = 'banner-actions';
    (actions || []).forEach((a) => {
      const btn = document.createElement('button');
      btn.textContent = a.text;
      btn.addEventListener('click', a.onClick);
      box.appendChild(btn);
    });
    banner.appendChild(span);
    banner.appendChild(box);
  }

  function hideBanner() {
    state.bannerKind = null;
    banner.className = 'banner hidden';
    banner.innerHTML = '';
  }

  function openDsPage() {
    chrome.tabs.create({ url: 'https://chat.deepseek.com/' });
  }

  async function reconnect() {
    conn.className = 'conn';
    connText.textContent = '正在连接…';
    const res = await sendCmd('ensure-tab');
    if (res && res.error) {
      state.connected = false;
      conn.className = 'conn bad';
      connText.textContent = '后台异常';
      showBanner('nopage', '后台异常：' + res.error + '。请到 edge://extensions 重新加载扩展后重试。', [
        { text: '打开网页', onClick: openDsPage },
        { text: '重试连接', onClick: reconnect },
      ]);
      return;
    }
    handleStatus(res && res.status, res && res.reason);
  }

  function handleStatus(status, reason) {
    if (!status) {
      state.connected = false;
      conn.className = 'conn bad';
      connText.textContent = '未连接';
      const retry = { text: '重试连接', onClick: reconnect };
      const open = { text: '打开网页', onClick: openDsPage };
      if (reason === 'bridge-unreachable') {
        showBanner('nopage', '已找到 DeepSeek 标签页，但页面脚本未就绪。请点“重试连接”；若仍失败，到 edge://extensions 重新加载扩展。', [retry, open]);
      } else {
        showBanner('nopage', '未能连接到 DeepSeek 页面，请点“打开网页”打开 chat.deepseek.com，或点“重试连接”。', [open, retry]);
      }
      return;
    }
    if (!status.loggedIn) {
      state.connected = false;
      conn.className = 'conn bad';
      connText.textContent = '未登录';
      showBanner('login', '请先在新标签页中登录 DeepSeek（登录状态由浏览器保存，插件不接触你的账号密码）', [{ text: '打开网页', onClick: openDsPage }, { text: '重试连接', onClick: reconnect }]);
      return;
    }
    state.connected = true;
    hideBanner();
    conn.className = 'conn ok';
    connText.textContent = status.hasComposer ? '已连接 · DeepSeek 网页版' : '已连接 · 等待聊天页面加载';
    // 弹窗重开时恢复正在生成的流
    if (status.stream && status.stream.askId && !state.askId && !status.stream.done) {
      state.askId = status.stream.askId;
      updateAssistant(status.stream);
      setGenerating(true);
    }
  }

  function handleEvent(p) {
    if (!p) return;
    switch (p.type) {
      case 'status':
        handleStatus(p.status, p.reason);
        break;
      case 'stream-start': {
        const s = p.stream;
        if (s && s.prompt && s.prompt !== state.lastUserText) {
          addUserMsg(s.prompt);
          state.assistant = null; // 页面上发起了新提问，另起气泡
        }
        state.askId = s.askId || state.askId;
        updateAssistant(s);
        setGenerating(true);
        break;
      }
      case 'stream-delta':
        updateAssistant(p.stream);
        break;
      case 'stream-end':
        finishAssistant(p.stream);
        break;
      case 'ask-error':
        addErrorMsg(p.error);
        state.askId = null;
        setGenerating(false);
        break;
      case 'new-chat':
        clearChat();
        if (!p.clicked) addSystemMsg('已清空插件对话（未能点击页面的“新对话”，网页上下文仍在原会话）');
        break;
    }
  }

  /* ---------------- 交互 ---------------- */

  /* ---------------- 图片附件 ---------------- */

  function renderAttachments() {
    const box = $('attachments');
    box.innerHTML = '';
    if (!state.files.length) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    state.files.forEach((f, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'thumb';
      const img = document.createElement('img');
      img.src = f.url;
      img.alt = f.name || 'image';
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = '移除';
      del.addEventListener('click', () => {
        state.files.splice(i, 1);
        renderAttachments();
      });
      wrap.appendChild(img);
      wrap.appendChild(del);
      box.appendChild(wrap);
    });
  }

  function addFile(file) {
    if (!file) return;
    if (state.files.length >= 4) { addSystemMsg('最多附加 4 张图片'); return; }
    if (file.size > 6 * 1024 * 1024) { addSystemMsg('单张图片不能超过 6MB'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      state.files.push({
        name: file.name || 'screenshot.png',
        type: file.type || 'image/png',
        url,
        data: url.split(',')[1] || '',
      });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }

  document.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let added = false;
    for (const it of items) {
      if (it.kind === 'file' && /^image\//.test(it.type)) {
        addFile(it.getAsFile());
        added = true;
      }
    }
    if (added) e.preventDefault();
  });

  $('btn-attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    Array.from(e.target.files || []).forEach(addFile);
    e.target.value = '';
  });

  /* ---------------- 发送 ---------------- */

  async function onSend() {
    let text = input.value.trim();
    const files = state.files.slice();
    if (!text && !files.length) return;
    if (!text && files.length) text = '请看这张图片';
    input.value = '';
    state.files = [];
    renderAttachments();
    const res = await sendCmd('ensure-tab');
    const status = res && res.status;
    if (!status) {
      addErrorMsg('无法连接 DeepSeek 页面，请打开 chat.deepseek.com 并登录后重试');
      return;
    }
    if (!status.loggedIn) {
      handleStatus(status);
      return;
    }
    const askId = 'a' + Date.now().toString(36);
    state.askId = askId;
    addUserMsg(text, files);
    startAssistant(askId);
    setGenerating(true);
    await sendCmd('ask', {
      askId,
      prompt: text,
      files: files.map((f) => ({ name: f.name, type: f.type, data: f.data })),
    });
  }

  btnSend.addEventListener('click', onSend);
  btnStop.addEventListener('click', () => sendCmd('stop'));
  btnNew.addEventListener('click', async () => {
    clearChat();
    await sendCmd('newChat');
  });
  btnOpen.addEventListener('click', openDsPage);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });

  /* ---------------- 启动 ---------------- */

  connect();
  addSystemMsg('你好，我是 DeepSeek 快捷提问。输入问题即可开始对话。');
  connText.textContent = '正在连接…';
  (async () => {
    await reconnect();
    // 首次连接常发生在扩展刚安装、页面脚本尚未就绪时，稍后再自动尝试一次
    if (!state.connected) setTimeout(() => { if (!state.connected) reconnect(); }, 4000);
  })();
  // 轮询状态：页面跳转/登录变化时自动更新横幅
  setInterval(() => {
    sendCmd('status').then((s) => { if (s) handleStatus(s); });
  }, 3000);
})();
