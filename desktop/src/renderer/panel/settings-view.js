/* Settings view of the panel: Models, Commands, Shortcuts, General.
   Edits are kept as a draft and written on Save; Cancel discards them.

   Usage (from panel.js):
     const settingsView = window.IPSettingsView({ cleanErr, onSaved });
     settingsView.open('models' | 'commands' | 'shortcuts' | 'general');
     settingsView.close();
     settingsView.isOpen
   `onSaved(settings)` is called after a successful save.
*/
window.IPSettingsView = ({ cleanErr, onSaved }) => {
  const $ = (id) => document.getElementById(id);
  const PROVS = ['gemini', 'groq', 'local'];
  const SOURCES = ['gemini', 'groq', 'local', 'cloud'];
  const FIELDS = ['backendUrl', 'firebaseApiKey', 'defaultAction', 'localOnly', 'ocrEnabled', 'selectionBubble', 'maxTurns', 'hardwareAcceleration'];

  let settings = {};
  let status = null; // { providers, keys } from main
  let selectedSource = 'gemini';
  const enabled = {}; // source -> shown in model menu (draft)
  const provDraft = {}; // prov -> { rows: Map(id -> row), removeKey, visionOnly }
  let commands = []; // draft list
  let editing = null; // { index | -1 for new }
  let defaultCommands = [];

  const pane = (p) => document.querySelector(`.prov-pane[data-prov="${p}"]`);
  const role = (p, r) => pane(p).querySelector(`[data-role="${r}"]`);
  const fmtSpeed = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
  const pretty = (acc) => String(acc || '').replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl').replace(/Super/g, 'Win');

  // ---------- tabs ----------

  function selectTab(tab) {
    for (const b of document.querySelectorAll('.settings-tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const p of document.querySelectorAll('[data-tab-panel]')) p.hidden = p.dataset.tabPanel !== tab;
    document.querySelector('.settings-body').scrollTop = 0;
  }

  // ---------- Models: source list ----------

  function sourceStatus(p) {
    if (p === 'cloud') {
      if (!settings.firebaseApiKey) return 'Not set up';
      return `${settings.backendUrl.replace(/^https?:\/\//, '')}`;
    }
    const n = [...provDraft[p].rows.values()].filter((r) => r.use).length;
    const ready = p === 'local' ? Boolean(role('local', 'url').value.trim()) : status.keys[p].set || Boolean(role(p, 'key').value.trim());
    if (!ready) return 'Not set up';
    return n ? `${n} model${n === 1 ? '' : 's'} chosen` : 'No models chosen yet';
  }

  function sourceName(p) {
    if (p === 'local') return role('local', 'label').value.trim() || 'Local server';
    return { gemini: 'Gemini', groq: 'Groq', cloud: 'IntelliPointer Cloud' }[p];
  }

  function renderSources() {
    const list = $('source-list');
    list.innerHTML = '';
    for (const p of SOURCES) {
      const row = document.createElement('div');
      row.className = 'source-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(p === selectedSource));
      row.tabIndex = 0;
      const text = document.createElement('div');
      text.className = 'source-text';
      const name = document.createElement('div');
      name.className = 'strong';
      name.textContent = sourceName(p);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = sourceStatus(p);
      text.append(name, meta);
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.className = 'switch';
      sw.checked = enabled[p];
      sw.title = 'Show this source in the model menu';
      sw.setAttribute('aria-label', `Show ${sourceName(p)} in the model menu`);
      sw.addEventListener('click', (e) => e.stopPropagation());
      sw.addEventListener('change', () => {
        enabled[p] = sw.checked;
      });
      row.append(text, sw);
      const select = () => {
        selectedSource = p;
        renderSources();
        for (const el of document.querySelectorAll('.prov-pane')) el.hidden = el.dataset.prov !== p;
      };
      row.addEventListener('click', select);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      });
      list.appendChild(row);
    }
    for (const el of document.querySelectorAll('.prov-pane')) el.hidden = el.dataset.prov !== selectedSource;
  }

  // ---------- Models: provider panes ----------

  function setProvStatus(p, text, isError = false) {
    const s = role(p, 'status');
    s.textContent = text;
    s.classList.toggle('error-text', isError);
  }

  function updateModelCount(p) {
    const rows = [...provDraft[p].rows.values()];
    const used = rows.filter((r) => r.use).length;
    const vision = rows.filter((r) => r.vision).length;
    setProvStatus(p, rows.length ? `${used} of ${rows.length} models chosen · ${vision} can read images.` : '');
    renderSources();
  }

  // Chosen models first, then fastest measured, then by name.
  function sortedIds(draft) {
    return [...draft.rows.keys()].sort((a, b) => {
      const ra = draft.rows.get(a);
      const rb = draft.rows.get(b);
      if (ra.use !== rb.use) return ra.use ? -1 : 1;
      const la = ra.latencyMs ?? Infinity;
      const lb = rb.latencyMs ?? Infinity;
      return la !== lb ? la - lb : a.localeCompare(b);
    });
  }

  function renderModelList(p) {
    const draft = provDraft[p];
    const list = role(p, 'list');
    const filter = role(p, 'filter').value.trim().toLowerCase();
    role(p, 'picker').hidden = draft.rows.size === 0;
    list.innerHTML = '';
    const ids = sortedIds(draft).filter((id) => id.toLowerCase().includes(filter) && (!draft.visionOnly || draft.rows.get(id).vision));
    if (!ids.length && draft.rows.size) list.innerHTML = '<div class="model-empty">No models match.</div>';
    for (const id of ids) {
      const row = draft.rows.get(id);
      const el = document.createElement('div');
      el.className = 'model-row';
      const use = document.createElement('label');
      use.className = 'model-use';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = row.use;
      cb.addEventListener('change', () => {
        row.use = cb.checked;
        updateModelCount(p);
      });
      const name = document.createElement('span');
      name.className = 'model-id';
      name.textContent = id;
      name.title = id;
      use.append(cb, name);

      const tags = document.createElement('span');
      tags.className = 'model-tags';
      if (row.reasoning) {
        const t = document.createElement('span');
        t.className = 'tag';
        t.textContent = 'reasoning';
        t.title = 'Thinks before answering, so it is usually slower to start';
        tags.appendChild(t);
      }
      if (row.testing || row.latencyMs || row.error) {
        const sp = document.createElement('span');
        sp.className = 'speed';
        if (row.testing) {
          sp.textContent = 'testing…';
        } else if (row.error) {
          sp.textContent = 'failed';
          sp.classList.add('slow');
          sp.title = row.error;
        } else {
          sp.textContent = fmtSpeed(row.latencyMs);
          sp.classList.add(row.latencyMs < 1500 ? 'fast' : row.latencyMs < 4000 ? 'ok' : 'slow');
          sp.title = 'Time until the first word of a reply (measured on this PC)';
        }
        tags.appendChild(sp);
      }

      const vision = document.createElement('button');
      vision.type = 'button';
      vision.className = 'vision-toggle';
      vision.title = row.visionSource === 'server'
        ? 'Image support as reported by the server (click to override)'
        : 'Whether this model can read images (screen captures)';
      vision.setAttribute('aria-pressed', String(row.vision));
      vision.innerHTML = window.ipIcon('image', 12);
      vision.append('Images');
      vision.addEventListener('click', () => {
        row.vision = !row.vision;
        vision.setAttribute('aria-pressed', String(row.vision));
      });
      el.append(use, tags, vision);
      list.appendChild(el);
    }
    updateModelCount(p);
  }

  // First load: tick a few sensible defaults so the model menu isn't empty.
  // For servers that report capabilities (9Router), prefer fast vision models.
  function preselect(p, fetched) {
    const prefer = {
      gemini: [/^gemini-flash-latest$/, /^gemini-flash-lite-latest$/, /^gemini-pro-latest$/],
      groq: [/llama-4-scout/, /llama-3\.3-70b/, /llama-4-maverick/],
      local: [],
    }[p];
    let picked = fetched.filter((m) => prefer.some((re) => re.test(m.id)));
    if (!picked.length) {
      const quick = /fast|flash|mini|lite|haiku|scout|turbo|instant|small/i;
      const score = (m) => (m.vision ? 4 : 0) + (m.reasoning ? 0 : 2) + (quick.test(m.id) ? 1 : 0);
      picked = [...fetched].sort((a, b) => score(b) - score(a));
    }
    for (const m of picked.slice(0, 4)) provDraft[p].rows.get(m.id).use = true;
  }

  async function fetchProviderModels(p) {
    const btn = role(p, 'load');
    btn.disabled = true;
    setProvStatus(p, 'Loading models…');
    try {
      const opts = { apiKey: role(p, 'key').value.trim() || undefined };
      if (p === 'local') opts.baseUrl = role(p, 'url').value.trim();
      const fetched = await window.ip.fetchProviderModels(p, opts);
      const draft = provDraft[p];
      const anyUsed = [...draft.rows.values()].some((r) => r.use);
      const merged = new Map();
      for (const m of fetched) {
        const prev = draft.rows.get(m.id);
        merged.set(m.id, {
          use: prev?.use ?? false,
          // The server's capability report wins over an earlier guess.
          vision: m.visionSource === 'server' || !prev ? m.vision : prev.vision,
          visionSource: m.visionSource,
          reasoning: m.reasoning,
          latencyMs: prev?.latencyMs ?? null,
        });
      }
      // Keep chosen models even if the server no longer lists them.
      for (const [id, row] of draft.rows) if (row.use && !merged.has(id)) merged.set(id, row);
      draft.rows = merged;
      if (!anyUsed) preselect(p, fetched);
      enabled[p] = true;
      renderModelList(p);
      if (!fetched.length) {
        setProvStatus(p, 'The server returned no chat models.', true);
      } else if (opts.apiKey || p === 'local') {
        // The key just worked: keep it, so it never has to be typed again.
        if (await save({ quiet: true })) setProvStatus(p, `Loaded ${fetched.length} models. Key saved on this PC.`);
      }
      return true;
    } catch (err) {
      setProvStatus(p, cleanErr(err), true);
      return false;
    } finally {
      btn.disabled = false;
    }
  }

  // Measures time-to-first-word for the chosen models (or the visible ones
  // if none are chosen), three at a time, then re-sorts fastest first.
  async function testSpeeds(p) {
    const draft = provDraft[p];
    const btn = role(p, 'speed');
    const filter = role(p, 'filter').value.trim().toLowerCase();
    let ids = sortedIds(draft).filter((id) => draft.rows.get(id).use);
    if (!ids.length) ids = sortedIds(draft).filter((id) => id.toLowerCase().includes(filter) && (!draft.visionOnly || draft.rows.get(id).vision)).slice(0, 8);
    if (!ids.length) return;
    btn.disabled = true;
    const opts = { apiKey: role(p, 'key').value.trim() || undefined };
    if (p === 'local') opts.baseUrl = role(p, 'url').value.trim();
    for (const id of ids) Object.assign(draft.rows.get(id), { testing: true, error: null });
    renderModelList(p);
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        const row = draft.rows.get(id);
        const res = await window.ip.speedTest(p, id, opts).catch((err) => ({ ok: false, error: cleanErr(err) }));
        Object.assign(row, { testing: false, latencyMs: res.ok ? res.firstTokenMs : null, error: res.ok ? null : res.error });
        renderModelList(p);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    btn.disabled = false;
    const ok = ids.map((id) => [id, draft.rows.get(id)]).filter(([, r]) => r.latencyMs).sort((a, b) => a[1].latencyMs - b[1].latencyMs);
    setProvStatus(p, ok.length
      ? `Fastest: ${ok[0][0]} (${fmtSpeed(ok[0][1].latencyMs)}). The model menu lists models fastest first after you save.`
      : 'None of the tested models replied. Hover "failed" to see why.', !ok.length);
  }

  function providerPatch() {
    const patch = { cloud: { enabled: enabled.cloud } };
    for (const p of PROVS) {
      const typed = role(p, 'key').value.trim();
      const draft = provDraft[p];
      // Saved in speed order, so the model menu lists the fastest first.
      patch[p] = {
        enabled: enabled[p],
        models: sortedIds(draft).filter((id) => draft.rows.get(id).use).map((id) => {
          const r = draft.rows.get(id);
          return { id, vision: r.vision, reasoning: Boolean(r.reasoning), latencyMs: r.latencyMs ?? null };
        }),
      };
      if (typed) patch[p].apiKey = typed;
      else if (draft.removeKey) patch[p].apiKey = '';
    }
    patch.local.baseUrl = role('local', 'url').value.trim();
    patch.local.label = role('local', 'label').value.trim();
    return patch;
  }

  async function loadProviders() {
    status = await window.ip.providerStatus();
    for (const p of SOURCES) enabled[p] = status.providers[p].enabled !== false;
    for (const p of PROVS) {
      provDraft[p] = {
        rows: new Map(status.providers[p].models.map((m) => [m.id, { use: true, vision: m.vision, reasoning: m.reasoning, latencyMs: m.latencyMs }])),
        removeKey: false,
        visionOnly: false,
      };
      role(p, 'vision-only').setAttribute('aria-pressed', 'false');
      role(p, 'key').value = '';
      role(p, 'hint').textContent = status.keys[p].set ? `Saved ${status.keys[p].hint}` : '';
      role(p, 'remove').hidden = !status.keys[p].set;
      role(p, 'filter').value = '';
    }
    role('local', 'url').value = status.providers.local.baseUrl;
    role('local', 'label').value = status.providers.local.label === 'Local' ? '' : status.providers.local.label;
    for (const p of PROVS) {
      renderModelList(p);
      const configured = p === 'local' ? Boolean(status.providers.local.baseUrl) : status.keys[p].set;
      if (configured && !provDraft[p].rows.size) setProvStatus(p, 'Click Load models to choose which models to use.');
    }
    // Open the first source that is set up.
    selectedSource = PROVS.find((p) => (p === 'local' ? status.providers.local.baseUrl : status.keys[p].set))
      || (settings.firebaseApiKey ? 'cloud' : 'gemini');
    renderSources();
  }

  // ---------- Cloud account ----------

  async function refreshAuth() {
    const s = await window.ip.authStatus();
    $('auth-out').hidden = s.signedIn;
    $('auth-in').hidden = !s.signedIn;
    $('who').textContent = s.email || '';
    $('auth-msg').textContent = s.secureStorage ? '' : 'Windows secure storage is unavailable, so you will need to sign in again after restarting.';
    if (s.signedIn) {
      try {
        const u = await window.ip.usage();
        $('usage').textContent = `${u.used} of ${u.limit} requests used today${u.outputTokens ? ` · ${u.outputTokens.toLocaleString()} output tokens` : ''}`;
      } catch (err) {
        $('usage').textContent = cleanErr(err);
      }
    }
  }

  async function doSignIn(create) {
    $('auth-msg').textContent = create ? 'Creating account…' : 'Signing in…';
    try {
      await save({ quiet: true }); // the Firebase key must be saved first
      await window.ip.signIn({ email: $('email').value.trim(), password: $('password').value, create });
      $('password').value = '';
      enabled.cloud = true;
      await refreshAuth();
      renderSources();
    } catch (err) {
      $('auth-msg').textContent = cleanErr(err);
    }
  }

  // ---------- Commands ----------

  let cmdShortcut = null;

  function renderCommands() {
    const list = $('command-list');
    list.innerHTML = '';
    commands.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'command-row';
      const text = document.createElement('div');
      text.className = 'command-text';
      const name = document.createElement('div');
      name.className = 'strong';
      name.textContent = c.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = c.prompt;
      text.append(name, meta);
      if (c.shortcut) {
        const keys = document.createElement('span');
        keys.className = 'keys small';
        for (const part of pretty(c.shortcut).split('+')) {
          const k = document.createElement('kbd');
          k.textContent = part;
          keys.appendChild(k);
        }
        name.appendChild(keys);
      }
      const tools = document.createElement('div');
      tools.className = 'command-tools';
      const btn = (icon, title, fn, pressed) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-btn small';
        b.title = title;
        b.setAttribute('aria-label', title);
        b.innerHTML = window.ipIcon(icon, 15);
        if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
        b.addEventListener('click', fn);
        tools.appendChild(b);
        return b;
      };
      btn('pin', c.pinned ? 'Unpin from toolbars' : 'Pin to toolbars', () => {
        if (!c.pinned && commands.filter((x) => x.pinned).length >= 4) {
          $('settings-msg').textContent = 'Up to 4 commands can be pinned.';
          return;
        }
        c.pinned = !c.pinned;
        renderCommands();
      }, c.pinned);
      btn('chevron-up', 'Move up', () => {
        if (i === 0) return;
        [commands[i - 1], commands[i]] = [commands[i], commands[i - 1]];
        renderCommands();
      }).disabled = i === 0;
      btn('chevron-down', 'Move down', () => {
        if (i === commands.length - 1) return;
        [commands[i + 1], commands[i]] = [commands[i], commands[i + 1]];
        renderCommands();
      }).disabled = i === commands.length - 1;
      btn('square-pen', 'Edit', () => openEditor(i));
      btn('trash-2', 'Delete', () => {
        commands.splice(i, 1);
        if (editing && editing.index === i) closeEditor();
        renderCommands();
        renderDefaultActionOptions();
      });
      row.append(text, tools);
      row.addEventListener('dblclick', () => openEditor(i));
      list.appendChild(row);
    });
    $('btn-add-command').disabled = commands.length >= 30;
  }

  function openEditor(index) {
    editing = { index };
    const c = index >= 0 ? commands[index] : { name: '', prompt: '', pinned: false, webSearch: false, shortcut: '' };
    $('cmd-name').value = c.name;
    $('cmd-prompt').value = c.prompt;
    $('cmd-pinned').checked = c.pinned;
    $('cmd-web').checked = c.webSearch;
    $('cmd-error').textContent = '';
    cmdShortcut = window.IPShortcutInput($('cmd-shortcut'), {
      value: c.shortcut,
      forKey: index >= 0 && c.id ? `command:${c.id}` : '',
      allowEmpty: true,
    });
    $('cmd-title').textContent = index >= 0 ? 'Edit command' : 'New command';
    $('command-editor').hidden = false;
    $('cmd-name').focus();
  }

  function closeEditor() {
    editing = null;
    $('command-editor').hidden = true;
  }

  function commitEditor() {
    const name = $('cmd-name').value.trim();
    const prompt = $('cmd-prompt').value.trim();
    if (!name || !prompt) {
      $('cmd-error').textContent = 'Give the command a name and a prompt.';
      return;
    }
    const pinnedElsewhere = commands.filter((x, i) => x.pinned && i !== editing.index).length;
    const next = {
      ...(editing.index >= 0 ? commands[editing.index] : {}),
      name,
      prompt,
      pinned: $('cmd-pinned').checked && pinnedElsewhere < 4,
      webSearch: $('cmd-web').checked,
      shortcut: cmdShortcut.value,
    };
    if (editing.index >= 0) commands[editing.index] = next;
    else commands.push(next);
    closeEditor();
    renderCommands();
    renderDefaultActionOptions();
  }

  function renderDefaultActionOptions() {
    const sel = $('s-defaultAction');
    const keep = sel.value || settings.defaultAction;
    sel.innerHTML = '';
    for (const c of commands) if (c.id) sel.add(new Option(c.name, c.id));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  // ---------- Shortcuts ----------

  let captureInput = null;
  let selectionInput = null;

  function renderShortcuts() {
    captureInput = window.IPShortcutInput($('hk-capture-input'), { value: settings.activeHotkeys?.captureHotkey || settings.captureHotkey, forKey: 'captureHotkey' });
    selectionInput = window.IPShortcutInput($('hk-selection-input'), { value: settings.activeHotkeys?.selectionHotkey || settings.selectionHotkey, forKey: 'selectionHotkey' });
  }

  // ---------- open / save ----------

  async function open(tab = 'models') {
    settings = await window.ip.getSettings();
    for (const f of FIELDS) {
      const el = $(`s-${f}`);
      if (el.type === 'checkbox') el.checked = settings[f];
      else el.value = settings[f];
    }
    commands = structuredClone(settings.commands);
    defaultCommands = settings.defaultCommands || defaultCommands;
    closeEditor();
    renderCommands();
    renderDefaultActionOptions();
    renderShortcuts();
    await loadProviders();
    const b = settings.build || {};
    $('version').textContent = `Version ${b.version || '?'} · ${b.commit === 'source' ? 'running from source' : `build ${b.commit}`}${b.builtAt ? ` · ${new Date(b.builtAt).toLocaleString()}` : ''}`;
    $('chat-view').hidden = true;
    $('settings-view').hidden = false;
    $('btn-settings').setAttribute('aria-pressed', 'true');
    $('settings-msg').textContent = '';
    selectTab(tab);
    refreshAuth();
  }

  function close() {
    $('settings-view').hidden = true;
    $('chat-view').hidden = false;
    $('btn-settings').setAttribute('aria-pressed', 'false');
  }

  async function save({ quiet = false } = {}) {
    const patch = {};
    for (const f of FIELDS) {
      const el = $(`s-${f}`);
      patch[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
    }
    patch.captureHotkey = captureInput.value;
    patch.selectionHotkey = selectionInput.value;
    patch.commands = commands;
    try {
      const gpuChanged = patch.hardwareAcceleration !== settings.hardwareAcceleration;
      const res = await window.ip.updateSettings(patch);
      await window.ip.saveProviders(providerPatch());
      settings = await window.ip.getSettings();
      commands = structuredClone(settings.commands);
      renderCommands();
      renderDefaultActionOptions();
      await loadProviders();
      if (!quiet) {
        const notes = [];
        if (res.hotkeyErrors.length) notes.push(`${res.hotkeyErrors.join(', ')} could not be used: another app owns it.`);
        if (gpuChanged) notes.push('Restart the app to apply the GPU setting.');
        $('settings-msg').textContent = notes.length ? `Saved. ${notes.join(' ')}` : 'Saved';
      }
      onSaved(settings);
      return true;
    } catch (err) {
      $('settings-msg').textContent = cleanErr(err);
      return false;
    }
  }

  // ---------- wiring ----------

  for (const b of document.querySelectorAll('.settings-tabs [data-tab]')) b.addEventListener('click', () => selectTab(b.dataset.tab));
  for (const p of PROVS) {
    role(p, 'load').addEventListener('click', () => fetchProviderModels(p));
    role(p, 'filter').addEventListener('input', () => renderModelList(p));
    role(p, 'speed').addEventListener('click', () => testSpeeds(p));
    role(p, 'vision-only').addEventListener('click', () => {
      provDraft[p].visionOnly = !provDraft[p].visionOnly;
      role(p, 'vision-only').setAttribute('aria-pressed', String(provDraft[p].visionOnly));
      renderModelList(p);
    });
    role(p, 'key').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') fetchProviderModels(p);
    });
    role(p, 'key').addEventListener('input', renderSources);
    role(p, 'remove').addEventListener('click', () => {
      provDraft[p].removeKey = true;
      role(p, 'key').value = '';
      role(p, 'hint').textContent = 'Removed when you save';
      role(p, 'remove').hidden = true;
    });
  }
  // Credentials are never left as an unsaved draft: leaving the field saves it.
  const autosave = (el) => el.addEventListener('change', () => {
    if (el.value.trim()) save({ quiet: true }).then((ok) => { if (ok) $('settings-msg').textContent = 'Saved'; });
  });
  for (const p of PROVS) autosave(role(p, 'key'));
  autosave($('s-backendUrl'));
  autosave($('s-firebaseApiKey'));
  role('local', 'url').addEventListener('input', renderSources);
  role('local', 'label').addEventListener('input', renderSources);
  // A preset may list several URLs (9Router: production port, then dev port);
  // the first one that answers is kept.
  for (const b of pane('local').querySelectorAll('[data-preset]')) {
    b.addEventListener('click', async () => {
      role('local', 'label').value = b.dataset.name;
      for (const url of b.dataset.preset.split(' ')) {
        role('local', 'url').value = url;
        if (await fetchProviderModels('local')) return;
      }
    });
  }
  $('btn-signin').addEventListener('click', () => doSignIn(false));
  $('btn-signup').addEventListener('click', () => doSignIn(true));
  $('btn-signout').addEventListener('click', async () => {
    await window.ip.signOut();
    refreshAuth();
  });

  $('btn-add-command').addEventListener('click', () => openEditor(-1));
  $('btn-cmd-cancel').addEventListener('click', closeEditor);
  $('btn-cmd-done').addEventListener('click', commitEditor);
  // Sheet: Esc or a click on the backdrop closes it; Ctrl+Enter saves.
  $('command-editor').addEventListener('mousedown', (e) => {
    if (e.target === $('command-editor')) closeEditor();
  });
  $('command-editor').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeEditor();
    } else if (e.key === 'Enter' && e.ctrlKey) {
      commitEditor();
    }
  });
  $('btn-reset-commands').addEventListener('click', () => {
    commands = structuredClone(defaultCommands);
    closeEditor();
    renderCommands();
    renderDefaultActionOptions();
  });
  $('btn-reset-shortcuts').addEventListener('click', () => {
    captureInput.set(settings.defaults?.captureHotkey || 'Alt+Shift+S');
    selectionInput.set(settings.defaults?.selectionHotkey || 'Alt+Shift+A');
    captureInput.check();
    selectionInput.check();
  });

  $('btn-save').addEventListener('click', () => save());
  $('btn-back').addEventListener('click', close);
  $('btn-latency').addEventListener('click', () => window.ip.openLatencyLog());
  $('btn-diagnostics').addEventListener('click', () => window.ip.openDiagnostics());

  return {
    open,
    close,
    get isOpen() {
      return !$('settings-view').hidden;
    },
  };
};
