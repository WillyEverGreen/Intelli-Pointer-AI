// Small "Ask AI" bar shown next to text the user just selected in another app.
// It never takes keyboard focus; clicks are handled by the main process.
(() => {
  window.ipApplyIcons();
  const bar = document.getElementById('bar');
  document.getElementById('ask').addEventListener('click', () => window.bubble.act(null));
  document.getElementById('close').addEventListener('click', () => window.bubble.close());
  for (const b of document.querySelectorAll('[data-action]')) {
    b.addEventListener('click', () => window.bubble.act(b.dataset.action));
  }
  bar.addEventListener('mouseenter', () => window.bubble.hover(true));
  bar.addEventListener('mouseleave', () => window.bubble.hover(false));
  window.bubble.onShow(({ preview }) => {
    bar.title = preview;
    // Restart the pop-in animation.
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = '';
  });
})();
