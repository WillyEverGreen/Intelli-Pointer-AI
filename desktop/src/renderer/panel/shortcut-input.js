/* Shortcut recorder: a button that shows a shortcut as key caps and, when
   clicked, records the next key combination pressed. It checks with the main
   process whether the combination is free (not used by another command here
   or by another app) and shows the result underneath.

   Usage:
     const input = window.IPShortcutInput(container, { value, forKey, allowEmpty, onChange });
     input.value      // Electron accelerator, e.g. "Alt+Shift+S" ('' = none)
     input.set(value)
*/
window.IPShortcutInput = (container, { value = '', forKey = '', allowEmpty = false, onChange = () => {} } = {}) => {
  let current = value;
  let recording = false;

  container.classList.add('shortcut-input');
  container.innerHTML = `
    <button type="button" class="shortcut-button"></button>
    <button type="button" class="icon-btn small shortcut-clear" title="Remove shortcut" data-icon="x"></button>
    <div class="shortcut-status" aria-live="polite"></div>`;
  window.ipApplyIcons(container);
  const button = container.querySelector('.shortcut-button');
  const clear = container.querySelector('.shortcut-clear');
  const status = container.querySelector('.shortcut-status');

  const pretty = (acc) => String(acc).replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl').replace(/Super/g, 'Win');

  function render() {
    button.innerHTML = '';
    button.classList.toggle('recording', recording);
    if (recording) {
      button.textContent = 'Press a shortcut…';
    } else if (!current) {
      button.textContent = allowEmpty ? 'None' : 'Not set';
      button.classList.add('empty');
    } else {
      button.classList.remove('empty');
      for (const part of pretty(current).split('+')) {
        const k = document.createElement('kbd');
        k.textContent = part;
        button.appendChild(k);
      }
    }
    clear.hidden = !allowEmpty || !current || recording;
  }

  function setStatus(text, kind = '') {
    status.textContent = text;
    status.className = `shortcut-status ${kind}`;
  }

  async function check() {
    if (!current) {
      setStatus('');
      return;
    }
    const res = await window.ip.checkHotkey(current, forKey).catch(() => ({ ok: true }));
    if (res.ok) setStatus('Available', 'ok');
    else setStatus(res.reason, 'error');
  }

  // KeyboardEvent.code -> Electron accelerator key name.
  function keyName(e) {
    const c = e.code;
    if (/^Key[A-Z]$/.test(c)) return c.slice(3);
    if (/^Digit\d$/.test(c)) return c.slice(5);
    if (/^F\d{1,2}$/.test(c)) return c;
    if (/^Numpad\d$/.test(c)) return `num${c.slice(6)}`;
    const map = {
      Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', ArrowUp: 'Up', ArrowDown: 'Down',
      ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      Insert: 'Insert', Delete: 'Delete', PrintScreen: 'PrintScreen', Pause: 'Pause',
    };
    return map[c] || null;
  }

  function onKeyDown(e) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return stop();
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.metaKey && allowEmpty) {
      current = '';
      stop();
      onChange(current);
      return;
    }
    if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key)) {
      const held = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean);
      button.textContent = `${held.join(' + ')} + …`;
      return;
    }
    const key = keyName(e);
    if (!key) return setStatus("That key can't be used in a shortcut.", 'error');
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    // A shortcut needs Ctrl, Alt or Win, unless it is a function key,
    // otherwise it would swallow normal typing everywhere.
    if (!/^F\d+$/.test(key) && !mods.some((m) => m !== 'Shift')) {
      return setStatus('Add Ctrl, Alt or Win so normal typing is not affected.', 'error');
    }
    current = [...mods, key].join('+');
    stop();
    onChange(current);
    check();
  }

  function start() {
    recording = true;
    render();
    setStatus('Press the keys together. Esc cancels' + (allowEmpty ? ', Backspace removes it.' : '.'));
    window.addEventListener('keydown', onKeyDown, true);
  }

  function stop() {
    recording = false;
    window.removeEventListener('keydown', onKeyDown, true);
    render();
    if (!status.classList.contains('error')) setStatus('');
  }

  button.addEventListener('click', () => (recording ? stop() : start()));
  button.addEventListener('blur', () => recording && stop());
  clear.addEventListener('click', () => {
    current = '';
    render();
    setStatus('');
    onChange(current);
  });
  render();

  return {
    get value() {
      return current;
    },
    set(next) {
      current = next || '';
      render();
      setStatus('');
    },
    check,
  };
};
