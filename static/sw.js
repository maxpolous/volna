/* Service worker: оболочка приложения — network-first (всегда свежая версия, когда есть сеть),
   с откатом в кэш офлайн. Сами треки лежат в IndexedDB (SW их не трогает). /api/* не кэшируем. */
const CACHE = "volna-shell-v6";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-180.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function withTimeout(p, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (err) => { clearTimeout(t); rej(err); });
  });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.pathname.includes("/api/")) return;   // API — только сеть
  if (url.origin !== location.origin) return;    // чужие домены (обложки) не трогаем

  e.respondWith((async () => {
    try {
      const resp = await withTimeout(fetch(e.request), 5000);
      if (resp && resp.ok) {
        const c = await caches.open(CACHE);
        c.put(e.request, resp.clone());
      }
      return resp;
    } catch {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      if (e.request.mode === "navigate") {
        return (await caches.match("index.html")) || new Response("offline", { status: 503 });
      }
      return new Response("offline", { status: 503 });
    }
  })());
});
