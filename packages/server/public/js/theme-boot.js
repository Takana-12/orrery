// Runs before the page is first drawn (a plain script in <head>, not a module, so it is not deferred):
// puts the chosen theme on <html> so a light theme never shows a dark first frame. Same key as ui/theme.js.
try {
  var t = localStorage.getItem('crTheme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
