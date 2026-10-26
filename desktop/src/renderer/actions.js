// Quick actions shared by the overlay toolbar and the panel.
// `webSearch: true` asks the backend to ground the answer with web search.
window.IP_ACTIONS = [
  { id: 'explain', label: 'Explain', prompt: 'Explain this.' },
  { id: 'define', label: 'Define', prompt: 'Define the key term(s) shown here concisely, with a one-line example.', cacheable: true },
  { id: 'summarize', label: 'Summarize', prompt: 'Summarize this in a few short bullet points.' },
  { id: 'fix', label: 'Fix error', prompt: 'Find the error(s) here and show the corrected version. Briefly explain each fix.' },
  { id: 'translate', label: 'Translate', prompt: 'Translate this into English. If it is already in English, translate it into Hindi. Keep the formatting.', cacheable: true },
  { id: 'steps', label: 'Step by step', prompt: 'Explain this step by step.' },
  { id: 'example', label: 'Example', prompt: 'Give a concrete example that illustrates this.' },
  { id: 'compare', label: 'Compare', prompt: 'Compare these items: similarities, differences, and when to use each. Use a table if helpful.' },
  { id: 'search', label: 'Search web', prompt: 'Search the web and give me current, sourced information about this.', webSearch: true },
];
