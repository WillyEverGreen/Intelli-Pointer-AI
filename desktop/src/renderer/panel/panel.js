/* Floating panel: attached context, conversation and composer.
   The model menu (model-menu.js) and settings (settings-view.js) are
   separate components wired up at the bottom of this file.
   All network access goes through window.ip (main process). */
(() => {
  const $ = (id) => document.getElementById(id);

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

  // Shows a one-line notice above the conversation, optionally with one action button.
  function banner(message, action = null) {
    const b = $('banner');
    b.hidden = !message;
    b.textContent = message || '';
    if (message && action) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      b.appendChild(btn);
    }
  }

  function setIcon(el, name) {
    el.querySelector(':scope > svg.icon')?.remove();
    el.insertAdjacentHTML('afterbegin', window.ipIcon(name));
  }

  const webSearchOn = () => $('web-search').getAttribute('aria-pressed') === 'true';

  const modelMenu = window.IPModelMenu({
    button: $('model-button'),
    popover: $('model-menu'),
    onChange: (id) => {
      updatePrivacy();
      window.ip.updateSettings({ defaultModel: id }).catch(() => {});
    },
    onManage: () => openSettings('models'),
  });
  const selectedModel = () => models.find((m) => m.id === modelMenu.value) || null;

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
    let errors = [];
    try {
      ({ models, errors } = await window.ip.listModels());
    } catch (err) {
      models = [];
      errors = [{ source: 'Models', message: cleanErr(err) }];
    }
    modelMenu.setModels(models, modelMenu.value || settings.defaultModel);
    if (!models.length) {
      const why = errors.length ? errors.map((e) => `${e.source}: ${e.message}`).join(' ') : 'Add a Gemini or Groq key, or a local server, to choose models.';
      banner(why, { label: 'Settings', onClick: openSettings });
    } else {
      banner('');
    }
    // A shortcut taken by another app silently does nothing, so say so until it's changed.
    if (settings.hotkeyErrors?.length) {
      const keys = settings.hotkeyErrors.map(prettyHotkey).join(' and ');
      banner(`${keys} is already used by another app, so that shortcut won't work. Choose a different one in Settings.`, { label: 'Settings', onClick: openSettings });
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
      const d = document.createElement('figure');
      d.className = 'thumb';
      d.title = `${img.label} · ${img.width} × ${img.height} px · ${(img.bytes / 1024).toFixed(0)} KB`;
      const i = document.createElement('img');
      i.src = img.dataUrl;
      i.alt = img.label;
      const s = document.createElement('figcaption');
      s.textContent = `${img.label} · ${img.width} × ${img.height}`;
      d.append(i, s);
      thumbs.appendChild(d);
    }
    // Header: what is attached.
    const n = context.images.length;
    const kindLabel = n
      ? `${n} screen region${n > 1 ? 's' : ''}`
      : context.kind === 'selection' ? 'Selected text' : 'Clipboard text';
    $('context-kind').innerHTML = window.ipIcon(n ? 'image' : 'type', 14);
    $('context-kind').append(kindLabel);

    // Text excerpt, clamped to three lines with a toggle.
    const clipText = $('clip-text');
    $('clip').hidden = !context.clipText;
    clipText.textContent = context.clipText || '';
    clipText.className = `clip-text ${context.clipExpanded ? 'expanded' : 'clamped'}`;
    requestAnimationFrame(() => {
      const overflowing = context?.clipExpanded || clipText.scrollHeight > clipText.clientHeight + 2;
      $('clip-more').hidden = !overflowing;
      $('clip-more').textContent = context?.clipExpanded ? 'Show less' : 'Show more';
    });

    const o = context.ocr;
    const st = $('ocr-status');
    if (!n) st.textContent = `${context.clipText.split(/\s+/).filter(Boolean).length} words`;
    else if (o.status === 'pending') st.textContent = 'Recognising text…';
    else if (o.status === 'error') st.textContent = o.error;
    else if (o.status === 'off') st.textContent = 'OCR off';
    else st.textContent = o.text ? `${o.text.split(/\s+/).length} words recognised · ${o.confidence}%` : 'No text recognised';
    st.title = o.text || '';
    $('send-ocr').disabled = !o.text;
    $('context-options').hidden = !n;
    $('btn-add-region').hidden = !n;
    updatePrivacy();
  }

  function updatePrivacy() {
    const p = $('privacy');
    const m = selectedModel();
    const show = (icon, text, title = text) => {
      p.innerHTML = window.ipIcon(icon, 13);
      const s = document.createElement('span');
      s.textContent = text;
      p.appendChild(s);
      p.title = title;
    };
    if (settings.localOnly && !m?.local) {
      show('lock', 'Local-only mode', 'Local-only mode is on: only models on your local server can be used.');
      return;
    }
    const parts = [];
    if (context?.images.length && $('send-image').checked && m?.vision) parts.push(`${context.images.length} image${context.images.length > 1 ? 's' : ''}`);
    if (context?.ocr.text && $('send-ocr').checked) parts.push('OCR text');
    if (context?.clipText) parts.push(context.kind === 'selection' ? 'selected text' : 'clipboard text');
    const provider = m ? m.label.split(' · ')[0] : 'the model provider';
    const what = parts.length ? `${parts.join(', ')} and your question` : 'your question';
    const route = !m ? '' : m.local ? ' (your local server)' : m.direct ? ' directly' : ' through IntelliPointer Cloud';
    let note = `Sends ${what} to ${provider}${route}.`;
    if (context?.images.length && m && !m.vision) note += ' This model is text-only, so images are not sent.';
    const short = parts.length ? `Sends ${parts.join(', ')}` : `Sends to ${provider}`;
    show(m?.local ? 'lock' : 'cloud', m?.local ? `${short} locally` : short, note);
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

  async function send(question, { cacheable = false, webSearch = webSearchOn() } = {}) {
    question = question.trim();
    if (!question) return;
    if (settings.localOnly && !selectedModel()?.local) {
      banner('Local-only mode is on. Choose a model from your local server.', { label: 'Settings', onClick: openSettings });
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
      bubble.innerHTML = '<span class="status">Recognising text…</span>';
      await context.ocrReady;
      useOcr = Boolean(context.ocr.text);
      if (!useOcr) {
        bubble.innerHTML = '<div class="error">No text was recognised and the image is not being sent. Turn on Image, or choose a model that accepts images.</div>';
        turns.pop();
        return;
      }
    }

    const reqId = `r${Date.now()}`;
    const body = { model: m.id, messages: buildMessages(useImages, useOcr), webSearch: webSearch && m.webSearch };
    current = { reqId, wrap, bubble, text: '', question, sources: [], opts: { cacheable, webSearch } };
    bubble.classList.add('streaming');
    bubble.innerHTML = `<span class="status">${useImages ? 'Uploading and waiting for a response…' : 'Waiting for a response…'}</span>`;
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
    const iconButton = (icon, title) => {
      const b = document.createElement('button');
      b.className = 'icon-btn';
      b.title = title;
      b.setAttribute('aria-label', title);
      setIcon(b, icon);
      tools.appendChild(b);
      return b;
    };
    if (text) {
      const copy = iconButton('copy', 'Copy');
      copy.addEventListener('click', async () => {
        await window.ip.copy(text);
        setIcon(copy, 'check');
        copy.title = 'Copied';
        setTimeout(() => {
          setIcon(copy, 'copy');
          copy.title = 'Copy';
        }, 1200);
      });
    }
    if (retryable !== false) {
      const retry = iconButton('rotate-ccw', 'Retry');
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

  // Runs a command (Settings → Commands) on the current context.
  function runAction(id) {
    const a = (settings.commands || []).find((x) => x.id === id);
    if (!a) return;
    // Text-only shortcut: for define/translate with clean OCR, skip the image upload.
    if (context?.images.length && a.cacheable && context.ocr.status === 'done' && context.ocr.text && context.ocr.confidence >= 80) {
      $('send-image').checked = false;
      updatePrivacy();
    }
    send(a.prompt, { cacheable: Boolean(a.cacheable), webSearch: Boolean(a.webSearch) || webSearchOn() });
  }

  // ---------- collapse / expand ----------

  function expand() {
    if (!document.body.classList.contains('collapsed')) return;
    document.body.classList.remove('collapsed');
    setIcon($('btn-collapse'), 'chevron-up');
    $('btn-collapse').title = 'Collapse';
    if (expandedHeight) window.ip.resize(expandedHeight);
  }

  function collapse() {
    expandedHeight = window.innerHeight;
    document.body.classList.add('collapsed');
    setIcon($('btn-collapse'), 'chevron-down');
    $('btn-collapse').title = 'Expand';
    window.ip.resize($('titlebar').offsetHeight + $('composer-area').offsetHeight + 2);
  }

  // ---------- commands ----------

  // One button per command, in the user's order (Settings → Commands).
  function renderCommandButtons() {
    const row = $('quick-actions');
    row.innerHTML = '';
    for (const c of settings.commands || []) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = c.name;
      b.title = c.prompt;
      b.addEventListener('click', () => runAction(c.id));
      row.appendChild(b);
    }
  }

  // ---------- settings ----------

  const settingsView = window.IPSettingsView({
    cleanErr,
    onSaved: (next) => {
      settings = next;
      applySettings();
      loadModels();
    },
  });
  const openSettings = (tab) => settingsView.open(typeof tab === 'string' ? tab : 'models');

  function prettyHotkey(h) {
    return String(h || '').replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl').replace(/Super/g, 'Win');
  }

  function renderKeys(el, accelerator) {
    el.innerHTML = '';
    for (const part of prettyHotkey(accelerator).split('+')) {
      const k = document.createElement('kbd');
      k.textContent = part;
      el.appendChild(k);
    }
  }

  function applySettings() {
    renderKeys($('hk-capture'), settings.activeHotkeys?.captureHotkey || settings.captureHotkey);
    renderKeys($('hk-selection'), settings.activeHotkeys?.selectionHotkey || settings.selectionHotkey);
    renderCommandButtons();
    updatePrivacy();
  }

  // ---------- wiring ----------

  window.ipApplyIcons();

  $('clip-more').addEventListener('click', () => {
    if (!context) return;
    context.clipExpanded = !context.clipExpanded;
    renderContext();
  });
  // Mouse wheel scrolls the command row sideways.
  $('quick-actions').addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      $('quick-actions').scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const v = $('input').value;
      if (!v.trim()) {
        // Empty Enter runs the default command.
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
  $('btn-newchat').addEventListener('click', () => {
    newConversation(true);
    settingsView.close();
    $('input').focus();
  });
  $('web-search').addEventListener('click', () => {
    $('web-search').setAttribute('aria-pressed', String(!webSearchOn()));
  });
  $('send-image').addEventListener('change', updatePrivacy);
  $('send-ocr').addEventListener('change', updatePrivacy);
  $('btn-pin').addEventListener('click', async () => {
    const btn = $('btn-pin');
    const pinned = await window.ip.pin(btn.getAttribute('aria-pressed') !== 'true');
    btn.setAttribute('aria-pressed', String(pinned));
    setIcon(btn, pinned ? 'pin' : 'pin-off');
    btn.title = pinned ? 'Keep on top' : 'Not kept on top';
  });
  $('btn-collapse').addEventListener('click', () => (document.body.classList.contains('collapsed') ? expand() : collapse()));
  $('btn-settings').addEventListener('click', () => (settingsView.isOpen ? settingsView.close() : openSettings()));
  $('btn-close').addEventListener('click', () => window.ip.hide());
  window.ip.onOpenSettings(() => openSettings());

  (async () => {
    settings = await window.ip.getSettings();
    applySettings();
    await loadModels();
    // First run with nothing set up: go straight to choosing a model source.
    if (!models.length) openSettings('models');
  })();
})();
