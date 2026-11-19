// Claude Browser init script (runs in every page before the page's own scripts).
// Keeps browsing in one tab: no pop-up windows, links and forms with a target open in place.
// The gateway also closes any tab beyond the second.
(() => {
  try {
    Object.defineProperty(window, 'open', { value: function () { return null; }, writable: false, configurable: false });
  } catch (e) { /* ignore */ }
  const toSelf = (e) => {
    try {
      const el = e.target && e.target.closest ? e.target.closest('a[target],area[target],form[target]') : null;
      if (el) el.setAttribute('target', '_self');
    } catch (err) { /* ignore */ }
  };
  document.addEventListener('click', toSelf, true);
  document.addEventListener('auxclick', toSelf, true);
  document.addEventListener('submit', toSelf, true);
})();
