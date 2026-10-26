/* Floating panel: screen context, conversation, composer, settings.
   All network access goes through window.ip (main process). */
(() => {
  const $ = (id) => document.getElementById(id);
  const ACTIONS = window.IP_ACTIONS;

  let settings = {};
  let models = [];
  let context = null; // { id, images, clipText, ocr: { status, text, confidence, ms }, timings }
  let turns = []; // { role, text }
  let current = null; // { reqId, el, text }
  let expandedHeight = null;

  // ---------- markdown ----------

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  const renderMarkdown = (text) => DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
  const highlight = (el) => el.querySelectorAll('pre code').forEach((c) => hljs.highlightElement(c));

  // ---------- helpers ----------

  function banner(html) {
    const b = $('banner');
    b.hidden = !html;
    b.innerHTML = html || '';
  }

  const selectedModel = () => models.find((m) => m.id === $('model').value) || null;

  function scrollDown() {
    const c = $('conversation');
    c.scrollTop = c.scrollHeight;
  }

  function fmtMs(ms) {
    if (ms == null) return '–';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
  }

  // ---------- models ----------

  async function loadModels() {
    try {
      models = await window.ip.listModels();
      const sel = $('model');
      const keep = sel.value || settings.defaultModel;
      sel.innerHTML = '';
      for (const m of models) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = `${m.label}${m.vision ? '' : ' (text only)'}`;
        sel.appendChild(o);
      }
      if (models.some((m) => m.id === keep)) sel.value = keep;
      if (!models.length) banner('The backend has no AI models configured.');
      else banner('');
    } catch (err) {
      models = [];
      $('model').innerHTML = '<option value="">(not connected)</option>';
      banner(`${escapeHtml(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))} <button id="banner-settings">Open settings</button>`);
      $('banner-settings')?.addEventListener('click', openSettings);
    }
    updatePrivacy();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  const cleanErr = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // ---------- screen context ----------

  function renderContext() {
    const box = $('context');
    if (!context) {
      box.hidden = true;
      updatePrivacy();
      return;
    }
    box.hidden = false;
    const thumbs = $('thumbs');
    thumbs.innerHTML = '';
    for (const img of context.images) {
      const d = document.createElement('div');
      d.className = 'thumb';
      d.title = `${img.label} · ${img.width}×${img.height}px · ${(img.bytes / 1024).toFixed(0)} KB`;
      const i = document.createElement('img');
      i.src = img.dataUrl;
      i.alt = img.label;
      const s = document.createElement('span');
      s.textContent = img.label.replace('Region ', '#');
      d.append(i, s);
      thumbs.appendChild(d);
    }
    if (context.clipText) {
      const t = document.createElement('div');
      t.className = 'clip-text';
      t.textContent = context.clipText;
      thumbs.appendChild(t);
    }
    const o = context.ocr;
    const st = $('ocr-status');
    if (!context.images.length) st.textContent = context.kind === 'selection' ? 'Selected text attached' : 'Copied text attached';
    else if (o.status === 'pending') st.textContent = 'OCR: reading text…';
    else if (o.status === 'error') st.textContent = o.error;
    else if (o.status === 'off') st.textContent = 'OCR off';
    else st.textContent = o.text ? `OCR: ${o.text.split(/\s+/).length} words · ${o.confidence}% confidence · ${fmtMs(o.ms)}` : 'OCR: no text found (image will be used)';
    st.title = o.text || '';
    $('send-ocr').disabled = !o.text;
    $('send-image').disabled = !context.images.length;
    updatePrivacy();
  }

  function updatePrivacy() {
    const p = $('privacy');
    const m = selectedModel();
    if (settings.localOnly) {
      p.textContent = '🔒 Local-only mode: nothing will be sent. Turn it off in Settings to ask the AI.';
      return;
    }
    const parts = [];
    if (context?.images.length && $('send-image').checked && m?.vision) parts.push(`${context.images.length} image${context.images.length > 1 ? 's' : ''}`);
    if (context?.ocr.text && $('send-ocr').checked) parts.push('OCR text');
    if (context?.clipText) parts.push(context.kind === 'selection' ? 'selected text' : 'copied text');
    parts.push('your question');
    let note = `☁ Sends ${parts.join(' + ')} to ${m ? m.label.split(' · ')[0] : 'the AI provider'} via your backend.`;
    if (context?.images.length && m && !m.vision) note += ' This model is text-only, so images are not sent.';
    p.textContent = note;
  }

  window.ip.onContext((d) => {
    if (d.mode === 'append' && context) {
      const offset = context.images.length;
      context.images.push(...d.images.map((img, i) => ({ ...img, label: `Region ${offset + i + 1}` })));
      context.ocr = { status: 'pending', text: context.ocr.text, confidence: context.ocr.confidence };
      context.pendingId = d.contextId;
    } else {
      newConversation(false);
      context = {
        id: d.contextId,
        kind: d.kind,
        pendingId: d.contextId,
        images: d.images,
        clipText: d.text || '',
        ocr: { status: d.images.length ? (settings.ocrEnabled ? 'pending' : 'off') : 'none', text: '', confidence: 0 },
        timings: d.timings || {},
      };
      $('send-image').checked = true;
      $('send-ocr').checked = true;
    }
    context.ocrReady = new Promise((resolve) => { context.resolveOcr = resolve; });
    if (context.ocr.status !== 'pending') context.resolveOcr();
    $('empty').hidden = true;
    expand();
    renderContext();
    if (d.action) runAction(d.action);
    else $('input').focus();
  });

  window.ip.onOcr((d) => {
    if (!context || d.contextId !== context.pendingId) return;
    const prev = context.ocr.text;
    if (d.error) context.ocr = { status: 'error', error: d.error, text: prev || '', confidence: 0, ms: d.ocrMs };
    else context.ocr = { status: 'done', text: [prev, d.text].filter(Boolean).join('\n\n'), confidence: d.confidence, ms: d.ocrMs };
    context.timings.ocrMs = d.ocrMs;
    context.resolveOcr?.();
    renderContext();
  });

  // ---------- conversation ----------

  function addMessage(role, text) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'user') bubble.textContent = text;
    wrap.appendChild(bubble);
    $('conversation').appendChild(wrap);
    $('empty').hidden = true;
    scrollDown();
    return wrap;
  }

  function newConversation(clearContext = true) {
    if (current) window.ip.cancel(current.reqId);
    current = null;
    turns = [];
    if (clearContext) context = null;
    for (const el of [...$('conversation').querySelectorAll('.msg')]) el.remove();
    $('empty').hidden = Boolean(context);
    setBusy(false);
    renderContext();
  }

  // Builds the API messages. The screen context (images, OCR, copied text)
  // is attached to the first user turn that is still inside the history
  // window, so follow-up questions keep "seeing" the original selection.
  function buildMessages(useImages, useOcr) {
    const maxTurns = settings.maxTurns || 10;
    let history = turns.slice(-(maxTurns * 2 - 1));
    while (history.length && history[0].role !== 'user') history = history.slice(1);
    return history.map((t, i) => {
      if (i !== 0 || !context) return { role: t.role, text: t.text };
      const extra = [];
      if (context.clipText) extra.push(`[Selected text]\n${context.clipText}`);
      if (useOcr && context.ocr.text) extra.push(`[OCR text from the selected region(s), may contain recognition errors]\n${context.ocr.text}`);
      const images = useImages ? context.images.map((img) => ({ mime: img.mime, data: img.base64 })) : [];
      if (images.length > 1) extra.push(`[${images.length} screen regions attached, in order: ${context.images.map((im) => im.label).join(', ')}]`);
      return { role: 'user', text: [t.text, ...extra].join('\n\n'), images };
    });
  }

  function setBusy(busy) {
    $('btn-stop').hidden = !busy;
    $('btn-send').disabled = busy;
  }

  async function send(question, { cacheable = false, webSearch = $('web-search').checked } = {}) {
    question = question.trim();
    if (!question) return;
    if (settings.localOnly) {
      banner('Local-only mode is on, so nothing is sent. Turn it off in Settings to ask the AI.');
      return;
    }
    const model = selectedModel();
    if (!model) {
      await loadModels();
      if (!selectedModel()) return;
    }
    const m = selectedModel();

    const useImages = Boolean(context?.images.length && $('send-image').checked && m.vision);
    let useOcr = Boolean(context?.images.length && $('send-ocr').checked && !$('send-ocr').disabled);

    turns.push({ role: 'user', text: question });
    addMessage('user', question);
    const wrap = addMessage('assistant', '');
    const bubble = wrap.querySelector('.bubble');

    // If no image is going out, the OCR text is the only context: wait for it.
    if (context?.images.length && !useImages && context.ocr.status === 'pending') {
      bubble.innerHTML = '<span class="status">Reading text from the selection (OCR)…</span>';
      await context.ocrReady;
      useOcr = Boolean(context.ocr.text);
      if (!useOcr) {
        bubble.innerHTML = '<div class="error">No readable text was found and no image is being sent. Tick "Send image" or pick a vision model.</div>';
        turns.pop();
        return;
      }
    }

    const reqId = `r${Date.now()}`;
    const body = { model: m.id, messages: buildMessages(useImages, useOcr), webSearch: webSearch && m.webSearch };
    current = { reqId, wrap, bubble, text: '', question, sources: [], opts: { cacheable, webSearch } };
    bubble.classList.add('streaming');
    bubble.innerHTML = `<span class="status">${useImages ? 'Uploading selection & waiting for the model…' : 'Waiting for the model…'}</span>`;
    setBusy(true);
    try {
      await window.ip.ask({
        reqId,
        body,
        cacheable: cacheable && !useImages,
        meta: { captureMs: context?.timings.captureMs, ocrMs: context?.timings.ocrMs },
      });
    } catch (err) {
      finishWithError(reqId, cleanErr(err), true);
    }
  }

  let renderPending = false;
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      if (!current) return;
      current.bubble.innerHTML = renderMarkdown(current.text);
      scrollDown();
    });
  }

  function addTools(wrap, { text, timing, retryable, question, opts }) {
    const tools = document.createElement('div');
    tools.className = 'tools';
    if (text) {
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        await window.ip.copy(text);
        copy.textContent = 'Copied ✓';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      });
      tools.appendChild(copy);
    }
    if (retryable !== false) {
      const retry = document.createElement('button');
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        // Rewind the conversation to just before this question, then ask again.
        const msgs = [...$('conversation').querySelectorAll('.msg')];
        const idx = msgs.indexOf(wrap);
        const nth = msgs.slice(0, idx).filter((el) => el.classList.contains('user')).length;
        msgs.slice(idx - 1).forEach((el) => el.remove());
        let seen = 0;
        const cut = turns.findIndex((t) => t.role === 'user' && ++seen === nth);
        if (cut !== -1) turns = turns.slice(0, cut);
        send(question, opts);
      });
      tools.appendChild(retry);
    }
    if (timing) {
      const t = document.createElement('span');
      t.className = 'timing';
      t.textContent = timing;
      tools.appendChild(t);
    }
    wrap.appendChild(tools);
  }

  function finishWithError(reqId, message, retryable) {
    if (!current || current.reqId !== reqId) return;
    const { wrap, bubble, question, opts } = current;
    bubble.classList.remove('streaming');
    const partial = current.text ? renderMarkdown(current.text) : '';
    bubble.innerHTML = `${partial}<div class="error">${escapeHtml(message)}</div>`;
    turns.pop(); // the question did not get a complete answer
    addTools(wrap, { retryable, question, opts });
    current = null;
    setBusy(false);
  }

  window.ip.onAskEvent(({ reqId, event, data }) => {
    if (!current || current.reqId !== reqId) return;
    if (event === 'delta') {
      current.text += data.text;
      scheduleRender();
    } else if (event === 'sources') {
      current.sources = data.items;
    } else if (event === 'error') {
      finishWithError(reqId, data.message, data.retryable);
    } else if (event === 'cancelled') {
      const { wrap, bubble, text, question, opts } = current;
      bubble.classList.remove('streaming');
      bubble.innerHTML = `${renderMarkdown(text)}<div class="status">Stopped.</div>`;
      if (text) turns.push({ role: 'assistant', text });
      else turns.pop();
      addTools(wrap, { text, question, opts });
      current = null;
      setBusy(false);
    } else if (event === 'done') {
      const { wrap, bubble, text, sources, question, opts } = current;
      bubble.classList.remove('streaming');
      bubble.innerHTML = renderMarkdown(text || '_(empty response)_');
      highlight(bubble);
      if (sources.length) {
        const ol = document.createElement('ol');
        ol.className = 'sources';
        for (const s of sources.slice(0, 8)) {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = s.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = s.title;
          li.appendChild(a);
          ol.appendChild(li);
        }
        bubble.appendChild(ol);
      }
      turns.push({ role: 'assistant', text });
      const ct = data.clientTimings || {};
      const timing = data.cached
        ? `cached · ${fmtMs(ct.totalMs)}`
        : [
            context?.timings.captureMs != null ? `capture ${fmtMs(context.timings.captureMs)}` : null,
            context?.timings.ocrMs != null ? `OCR ${fmtMs(context.timings.ocrMs)}` : null,
            `upload ${(ct.uploadBytes / 1024).toFixed(0)} KB`,
            `first token ${fmtMs(ct.firstTokenMs)}`,
            `total ${fmtMs(ct.totalMs)}`,
          ].filter(Boolean).join(' · ');
      addTools(wrap, { text, timing, question, opts });
      current = null;
      setBusy(false);
      scrollDown();
    }
  });

  function runAction(id) {
    const a = ACTIONS.find((x) => x.id === id);
    if (!a) return;
    // Text-only shortcut: for define/translate with clean OCR, skip the image upload.
    if (context?.images.length && a.cacheable && context.ocr.status === 'done' && context.ocr.text && context.ocr.confidence >= 80) {
      $('send-image').checked = false;
      updatePrivacy();
    }
    send(a.prompt, { cacheable: Boolean(a.cacheable), webSearch: Boolean(a.webSearch) || $('web-search').checked });
  }

  // ---------- collapse / expand ----------

  function expand() {
    if (!document.body.classList.contains('collapsed')) return;
    document.body.classList.remove('collapsed');
    $('btn-collapse').textContent = '▾';
    if (expandedHeight) window.ip.resize(expandedHeight);
  }

  function collapse() {
    expandedHeight = window.innerHeight;
    document.body.classList.add('collapsed');
    $('btn-collapse').textContent = '▸';
    window.ip.resize(document.getElementById('titlebar').offsetHeight + $('composer').offsetHeight + 4);
  }

  // ---------- settings ----------

  const SETTING_FIELDS = ['backendUrl', 'firebaseApiKey', 'defaultAction', 'localOnly', 'ocrEnabled', 'selectionBubble', 'maxTurns', 'captureHotkey', 'clipboardHotkey'];

  async function refreshAuth() {
    const s = await window.ip.authStatus();
    $('auth-out').hidden = s.signedIn;
    $('auth-in').hidden = !s.signedIn;
    $('who').textContent = s.email || '';
    $('auth-msg').textContent = s.secureStorage ? '' : 'Warning: OS secure storage unavailable; you will need to sign in again after restarting.';
    if (s.signedIn) {
      try {
        const u = await window.ip.usage();
        $('usage').textContent = `Today: ${u.used} / ${u.limit} requests${u.outputTokens ? ` · ${u.outputTokens} output tokens` : ''}`;
      } catch (err) {
        $('usage').textContent = cleanErr(err);
      }
    }
  }

  async function openSettings() {
    settings = await window.ip.getSettings();
    for (const f of SETTING_FIELDS) {
      const el = $(`s-${f}`);
      if (el.type === 'checkbox') el.checked = settings[f];
      else el.value = settings[f];
    }
    $('chat-view').hidden = true;
    $('settings-view').hidden = false;
    $('settings-msg').textContent = '';
    expand();
    refreshAuth();
  }

  function closeSettings() {
    $('settings-view').hidden = true;
    $('chat-view').hidden = false;
  }

  async function saveSettings() {
    const patch = {};
    for (const f of SETTING_FIELDS) {
      const el = $(`s-${f}`);
      patch[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
    }
    try {
      const res = await window.ip.updateSettings(patch);
      settings = res.settings;
      applySettings();
      $('settings-msg').textContent = res.hotkeyErrors.length ? `Saved, but these hotkeys are taken: ${res.hotkeyErrors.join(', ')}` : 'Saved ✓';
      loadModels();
    } catch (err) {
      $('settings-msg').textContent = cleanErr(err);
    }
  }

  async function doSignIn(create) {
    $('auth-msg').textContent = create ? 'Creating account…' : 'Signing in…';
    try {
      // Save connection fields first so the API key is available.
      await saveSettings();
      await window.ip.signIn({ email: $('email').value.trim(), password: $('password').value, create });
      $('password').value = '';
      await refreshAuth();
      loadModels();
    } catch (err) {
      $('auth-msg').textContent = cleanErr(err);
    }
  }

  function prettyHotkey(h) {
    return h.replace('CommandOrControl', 'Ctrl');
  }

  function applySettings() {
    $('hk-capture').textContent = prettyHotkey(settings.captureHotkey);
    $('hk-clip').textContent = prettyHotkey(settings.clipboardHotkey);
    updatePrivacy();
  }

  // ---------- wiring ----------

  for (const a of ACTIONS) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.title = a.prompt;
    b.addEventListener('click', () => runAction(a.id));
    $('quick-actions').appendChild(b);
  }
  const sel = $('s-defaultAction');
  for (const a of ACTIONS) sel.add(new Option(a.label, a.id));

  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const v = $('input').value;
      if (!v.trim()) {
        // Empty Enter runs the default quick action.
        runAction(settings.defaultAction);
        return;
      }
      $('input').value = '';
      send(v);
    } else if (e.key === 'Escape') {
      window.ip.hide();
    }
  });
  $('btn-send').addEventListener('click', () => {
    const v = $('input').value;
    if (!v.trim()) return runAction(settings.defaultAction);
    $('input').value = '';
    send(v);
  });
  $('btn-stop').addEventListener('click', () => current && window.ip.cancel(current.reqId));
  $('btn-capture').addEventListener('click', () => window.ip.capture('replace'));
  $('btn-add-region').addEventListener('click', () => window.ip.capture('append'));
  $('btn-replace').addEventListener('click', () => window.ip.capture('replace'));
  $('btn-new').addEventListener('click', () => newConversation(true));
  $('send-image').addEventListener('change', updatePrivacy);
  $('send-ocr').addEventListener('change', updatePrivacy);
  $('model').addEventListener('change', () => {
    updatePrivacy();
    window.ip.updateSettings({ defaultModel: $('model').value }).catch(() => {});
  });
  $('btn-pin').addEventListener('click', async () => {
    const pinned = await window.ip.pin(!$('btn-pin').classList.contains('active'));
    $('btn-pin').classList.toggle('active', pinned);
    $('btn-pin').title = pinned ? 'Keep on top (pinned)' : 'Not on top (unpinned)';
  });
  $('btn-collapse').addEventListener('click', () => (document.body.classList.contains('collapsed') ? expand() : collapse()));
  $('btn-settings').addEventListener('click', () => ($('settings-view').hidden ? openSettings() : closeSettings()));
  $('btn-close').addEventListener('click', () => window.ip.hide());
  $('btn-save').addEventListener('click', saveSettings);
  $('btn-back').addEventListener('click', closeSettings);
  $('btn-signin').addEventListener('click', () => doSignIn(false));
  $('btn-signup').addEventListener('click', () => doSignIn(true));
  $('btn-signout').addEventListener('click', async () => {
    await window.ip.signOut();
    refreshAuth();
  });
  $('btn-latency').addEventListener('click', () => window.ip.openLatencyLog());

  (async () => {
    settings = await window.ip.getSettings();
    applySettings();
    await loadModels();
    const auth = await window.ip.authStatus();
    if (!auth.signedIn && !settings.firebaseApiKey && !models.length) openSettings();
  })();
})();
