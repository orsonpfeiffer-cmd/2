// Runs before first paint so the saved theme applies without a flash. Dark is the default.
try {
  var t = JSON.parse(localStorage.getItem('cr.theme'));
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
