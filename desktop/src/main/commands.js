// Commands: named prompts shown as buttons in the panel, and (when pinned)
// in the selection toolbar and the Ask bar. Each may have its own global
// shortcut, which runs it on the selected text, or opens a screen selection
// when no text is selected. Users can add, edit, reorder and delete them;
// the defaults below seed the list on first run.

const DEFAULT_COMMANDS = [
  { id: 'explain', name: 'Explain', prompt: 'Explain this.', pinned: true },
  { id: 'summarize', name: 'Summarize', prompt: 'Summarize this in a few short bullet points.', pinned: true },
  { id: 'translate', name: 'Translate', prompt: 'Translate this into English. If it is already in English, translate it into Hindi. Keep the formatting.', pinned: true, cacheable: true },
  { id: 'define', name: 'Define', prompt: 'Define the key term(s) shown here concisely, with a one-line example.', cacheable: true },
  { id: 'fix', name: 'Fix error', prompt: 'Find the error(s) here and show the corrected version. Briefly explain each fix.' },
  { id: 'steps', name: 'Step by step', prompt: 'Explain this step by step.' },
  { id: 'example', name: 'Example', prompt: 'Give a concrete example that illustrates this.' },
  { id: 'compare', name: 'Compare', prompt: 'Compare these items: similarities, differences, and when to use each. Use a table if helpful.' },
  { id: 'search', name: 'Search web', prompt: 'Search the web and give me current, sourced information about this.', webSearch: true },
];

const MAX_COMMANDS = 30;
const MAX_PINNED = 4;

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'command';
}

// Validates a user-supplied command list. Invalid entries are dropped,
// ids are made unique, and at most MAX_PINNED stay pinned.
function clean(list) {
  if (!Array.isArray(list)) return structuredClone(DEFAULT_COMMANDS);
  const ids = new Set();
  let pinned = 0;
  const out = [];
  for (const c of list.slice(0, MAX_COMMANDS)) {
    if (!c || typeof c.name !== 'string' || typeof c.prompt !== 'string') continue;
    const name = c.name.trim().slice(0, 40);
    const prompt = c.prompt.trim().slice(0, 4000);
    if (!name || !prompt) continue;
    let id = typeof c.id === 'string' && /^[a-z0-9-]{1,40}$/.test(c.id) ? c.id : slug(name);
    for (let n = 2; ids.has(id); n++) id = `${slug(name)}-${n}`;
    ids.add(id);
    const pin = c.pinned === true && pinned < MAX_PINNED;
    if (pin) pinned += 1;
    out.push({
      id,
      name,
      prompt,
      webSearch: c.webSearch === true,
      cacheable: c.cacheable === true,
      pinned: pin,
      shortcut: typeof c.shortcut === 'string' ? c.shortcut.trim().slice(0, 60) : '',
    });
  }
  return out;
}

module.exports = { DEFAULT_COMMANDS, MAX_PINNED, clean };
