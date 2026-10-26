// Ask bar: shown next to text the user just selected in another app.
// It never takes keyboard focus; clicks are handled by the main process.
// Buttons: "Ask" (opens the composer) plus the user's pinned commands.
(() => {
  window.ipApplyIcons();
  const bar = document.getElementById('bar');
  const commands = document.getElementById('commands');

  document.getElementById('ask').addEventListener('click', () => window.bubble.act(null));
  document.getElementById('close').addEventListener('click', () => window.bubble.close());
  bar.addEventListener('mouseenter', () => window.bubble.hover(true));
  bar.addEventListener('mouseleave', () => window.bubble.hover(false));

  window.bubble.onShow(({ preview, commands: list = [] }) => {
    bar.title = preview;
    commands.innerHTML = '';
    for (const c of list) {
      const b = document.createElement('button');
      b.className = 'btn ghost';
      b.textContent = c.name;
      b.addEventListener('click', () => window.bubble.act(c.id));
      commands.appendChild(b);
    }
    commands.previousElementSibling.hidden = !list.length; // the separator
    // Fit the window to the bar (command names vary in length).
    const r = bar.getBoundingClientRect();
    window.bubble.resize(Math.ceil(r.right + 6), Math.ceil(r.bottom + 6));
    // Restart the pop-in animation.
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = '';
  });
})();
