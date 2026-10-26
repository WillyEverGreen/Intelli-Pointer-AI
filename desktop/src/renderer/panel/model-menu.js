/* Model menu: the model picker in the panel's title bar.
   A button showing the current model, opening a searchable list grouped by
   provider, with image support and measured speed per model. Keyboard:
   Up/Down to move, Enter to choose, Esc to close, type to filter.

   Usage:
     const menu = window.IPModelMenu({ button, popover, onChange, onManage });
     menu.setModels(models, selectedId);   // models: [{ id, label, group, vision, latencyMs }]
     menu.value                            // selected model id ('' if none)
*/
window.IPModelMenu = ({ button, popover, onChange, onManage }) => {
  let models = [];
  let value = '';
  let active = 0; // index into the visible list
  let visible = [];

  const nameOf = (m) => m.label.split(' · ').pop();
  const fmtSpeed = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

  popover.innerHTML = `
    <div class="mm-search"><input type="text" placeholder="Search models" aria-label="Search models" spellcheck="false" /></div>
    <div class="mm-list" role="listbox" aria-label="Models"></div>
    <div class="mm-footer"><button type="button" class="btn ghost mm-manage" data-icon="settings">Manage models</button></div>`;
  const search = popover.querySelector('input');
  const list = popover.querySelector('.mm-list');
  window.ipApplyIcons(popover);

  function renderButton() {
    const m = models.find((x) => x.id === value);
    button.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'mm-current';
    label.textContent = m ? nameOf(m) : models.length ? 'Choose a model' : 'No models';
    button.title = m ? `${m.label}${m.vision ? ' · reads images' : ' · text only'}` : 'Choose a model';
    if (m && !m.vision) {
      const t = document.createElement('span');
      t.className = 'mm-textonly';
      t.textContent = 'text';
      button.appendChild(label);
      button.appendChild(t);
    } else {
      button.appendChild(label);
    }
    button.insertAdjacentHTML('beforeend', window.ipIcon('chevron-down', 14));
  }

  function renderList() {
    const q = search.value.trim().toLowerCase();
    visible = models.filter((m) => !q || m.label.toLowerCase().includes(q));
    list.innerHTML = '';
    if (!visible.length) {
      list.innerHTML = `<div class="mm-empty">${models.length ? 'No models match.' : 'No models yet. Add a provider in Settings.'}</div>`;
      return;
    }
    active = Math.min(active, visible.length - 1);
    let group = null;
    visible.forEach((m, i) => {
      if (m.group !== group) {
        group = m.group;
        const h = document.createElement('div');
        h.className = 'mm-group';
        h.textContent = group;
        list.appendChild(h);
      }
      const item = document.createElement('div');
      item.className = 'mm-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(m.id === value));
      item.classList.toggle('active', i === active);
      item.dataset.index = String(i);
      const name = document.createElement('span');
      name.className = 'mm-name';
      name.textContent = nameOf(m);
      name.title = m.label;
      item.appendChild(name);
      if (m.latencyMs) {
        const s = document.createElement('span');
        s.className = `mm-speed ${m.latencyMs < 1500 ? 'fast' : m.latencyMs < 4000 ? 'ok' : 'slow'}`;
        s.textContent = fmtSpeed(m.latencyMs);
        s.title = 'Time to first word, measured on this PC';
        item.appendChild(s);
      }
      const v = document.createElement('span');
      v.className = `mm-vision${m.vision ? '' : ' off'}`;
      v.title = m.vision ? 'Reads images (screen captures)' : 'Text only: images are sent as OCR text';
      v.innerHTML = window.ipIcon(m.vision ? 'image' : 'type', 13);
      item.appendChild(v);
      const check = document.createElement('span');
      check.className = 'mm-check';
      if (m.id === value) check.innerHTML = window.ipIcon('check', 14);
      item.appendChild(check);
      item.addEventListener('mousemove', () => setActive(i));
      item.addEventListener('click', () => choose(m.id));
      list.appendChild(item);
    });
  }

  function setActive(i) {
    if (i === active) return;
    active = i;
    list.querySelectorAll('.mm-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.index) === i));
  }

  function choose(id) {
    close();
    if (id === value) return;
    value = id;
    renderButton();
    onChange(id);
  }

  function open() {
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    search.value = '';
    active = Math.max(0, models.findIndex((m) => m.id === value));
    renderList();
    search.focus();
    list.querySelector('.mm-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  function close() {
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  button.setAttribute('aria-haspopup', 'listbox');
  button.addEventListener('click', () => (popover.hidden ? open() : close()));
  search.addEventListener('input', () => {
    active = 0;
    renderList();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!visible.length) return;
      setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length);
      list.querySelector('.mm-item.active')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (visible[active]) choose(visible[active].id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      button.focus();
    }
  });
  popover.querySelector('.mm-manage').addEventListener('click', () => {
    close();
    onManage();
  });
  document.addEventListener('mousedown', (e) => {
    if (!popover.hidden && !popover.contains(e.target) && !button.contains(e.target)) close();
  });
  window.addEventListener('blur', close);

  return {
    setModels(next, selectedId) {
      models = next;
      value = models.some((m) => m.id === selectedId) ? selectedId : models[0]?.id || '';
      renderButton();
      if (!popover.hidden) renderList();
    },
    get value() {
      return value;
    },
    close,
  };
};
