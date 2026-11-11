// What the browser needs for the phone push (#C904), served by the Worker behind Access like the page:
//   /sw.js                  the service worker: shows a push, and opens (or focuses) the board when it is tapped;
//   /manifest.webmanifest   so an iPhone can add the board to the Home Screen, the only place iOS allows Web Push (16.4+).
// The push's words come from push-rules.mjs (counts, ask numbers, versions); the worker shows them as text, never as HTML.
export const SW_SOURCE = `// Flight board service worker (#C904): shows the board's pushes; a tap opens the board.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = {}; }
  const title = typeof d.title === "string" && d.title ? d.title.slice(0, 80) : "Flight board";
  const body = typeof d.body === "string" && d.body ? d.body.slice(0, 300) : "Something on the board needs you.";
  e.waitUntil(self.registration.showNotification(title, { body, tag: "board", renotify: true, data: { url: "/" } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    for (const w of wins) if (new URL(w.url).origin === self.location.origin && "focus" in w) return w.focus();
    return self.clients.openWindow("/");
  }));
});
`;

export const MANIFEST = JSON.stringify({
  name: "Flight board",
  short_name: "Board",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0f1419",
  theme_color: "#0f1419",
});
