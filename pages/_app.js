const reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
try { await reg.update(); } catch (_) {}

if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });

navigator.serviceWorker.addEventListener("controllerchange", () => {
  // Recharge 1 fois quand une nouvelle version prend la main
  window.location.reload();
});
