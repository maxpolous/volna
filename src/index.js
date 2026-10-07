// Cloudflare Worker: раздаёт PWA (через ASSETS) и обрабатывает /api/* (SoundCloud-клиент).
// Без Python/ffmpeg — чистый JS, работает на бесплатном Workers.
// Качает только НЕзащищённые потоки (progressive MP3 / plain-HLS). DRM-треки не трогаем.
// Вход — токен сессии (cookie oauth_token) в заголовке X-SC-Token; Worker его не хранит.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const H = { "User-Agent": UA, Referer: "https://soundcloud.com/", Origin: "https://soundcloud.com" };
const hdr = (token) => (token ? { ...H, Authorization: "OAuth " + token } : H);

const ROUTES = ["info", "download", "thumb", "sc/me", "sc/likes", "sc/playlists", "sc/playlist", "sc/search"];

let CLIENT_ID = null;

async function getClientId(force = false) {
  if (CLIENT_ID && !force) return CLIENT_ID;
  const html = await (await fetch("https://soundcloud.com/", { headers: H })).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => u.includes("sndcdn.com/assets"));
  for (const url of scripts.reverse()) {
    const js = await (await fetch(url, { headers: H })).text();
    const m = js.match(/client_id:"([a-zA-Z0-9]{20,})"/) || js.match(/client_id=([a-zA-Z0-9]{20,})/);
    if (m) {
      CLIENT_ID = m[1];
      return CLIENT_ID;
    }
  }
  throw new Error("SoundCloud client_id не найден");
}

// path — с query-строкой (хотя бы «?»), client_id добавляем сами
async function scApi(path, token = "") {
  let cid = await getClientId();
  const sep = path.includes("?") ? "&" : "?";
  let r = await fetch(`https://api-v2.soundcloud.com${path}${sep}client_id=${cid}`, { headers: hdr(token) });
  if (r.status === 401) {
    cid = await getClientId(true);
    r = await fetch(`https://api-v2.soundcloud.com${path}${sep}client_id=${cid}`, { headers: hdr(token) });
  }
  if (r.status === 401) throw new Error(token ? "TOKEN" : "SoundCloud API 401");
  if (r.status === 404) throw new Error("NOT_FOUND");
  if (!r.ok) throw new Error("SoundCloud API " + r.status);
  return r.json();
}

// короткие ссылки on.soundcloud.com / редиректы -> канонический URL
async function canonical(url) {
  if (/soundcloud\.com\/.+\/.+/i.test(url) && !/on\.soundcloud\.com/i.test(url)) return url.split("?")[0];
  try {
    const r = await fetch(url, { headers: H, redirect: "follow" });
    if (r.status === 404) throw new Error("NOT_FOUND");
    return (r.url || url).split("?")[0];
  } catch (e) {
    if (e.message === "NOT_FOUND") throw e;
    return url;
  }
}

async function resolveTrack(rawUrl, token) {
  const url = await canonical(rawUrl);
  const data = await scApi(`/resolve?url=${encodeURIComponent(url)}`, token);
  if (data.kind === "playlist" && Array.isArray(data.tracks) && data.tracks.length) {
    const first = data.tracks[0];
    return first.media ? first : scApi(`/tracks/${first.id}`, token);
  }
  if (data.kind !== "track") throw new Error("Это не трек SoundCloud");
  return data;
}

function bigArt(t) {
  const a = t.artwork_url || t.user?.avatar_url || "";
  return a ? a.replace("-large.", "-t500x500.") : "";
}

// только незащищённые варианты: progressive MP3, затем plain-HLS MP3
function plainTranscodings(t) {
  const ts = t.media?.transcodings || [];
  const prog = ts.filter((x) => x.format?.protocol === "progressive");
  const hls = ts.filter((x) => x.format?.protocol === "hls" && /mpeg/.test(x.format?.mime_type || ""));
  return [...prog, ...hls]; // encrypted-hls (DRM) намеренно исключены
}

function trackBrief(t) {
  const ts = t.media?.transcodings || [];
  return {
    id: t.id,
    title: t.title,
    uploader: t.user?.username,
    duration: Math.round((t.duration || 0) / 1000),
    thumbnail: bigArt(t),
    url: t.permalink_url,
    drm: ts.length ? plainTranscodings(t).length === 0 : false,
  };
}

async function authStreamUrl(tr, cid, track, token) {
  const q = `?client_id=${cid}&track_authorization=${encodeURIComponent(track.track_authorization || "")}`;
  const r = await fetch(tr.url + q, { headers: hdr(token) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j.url || null;
}

function metaHeaders(t, mime) {
  const q = encodeURIComponent;
  return {
    "Content-Type": mime,
    "X-Title": q(t.title || "Без названия"),
    "X-Uploader": q(t.user?.username || ""),
    "X-Duration": String(Math.round((t.duration || 0) / 1000)),
    "X-Thumbnail": q(bigArt(t)),
    "X-Track-Id": q(String(t.id || "")),
    "X-Source": "Soundcloud",
    "Access-Control-Expose-Headers":
      "X-Title,X-Uploader,X-Duration,X-Thumbnail,X-Track-Id,X-Source",
  };
}

const isYouTube = (u) => /(^|\.)youtube\.com|youtu\.be/i.test(u);

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
const err = (msg, code = 400) => json({ detail: msg }, code);

async function concatHls(m3u8Url, track, mime, token) {
  const m3u8 = await (await fetch(m3u8Url, { headers: hdr(token) })).text();
  const segs = m3u8.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!segs.length) throw new Error("Пустой HLS-плейлист");
  const parts = [];
  for (const s of segs) parts.push(new Uint8Array(await (await fetch(s, { headers: hdr(token) })).arrayBuffer()));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return new Response(out, { headers: metaHeaders(track, mime) });
}

async function download(track, token) {
  const cid = await getClientId();
  for (const tr of plainTranscodings(track)) {
    const streamUrl = await authStreamUrl(tr, cid, track, token);
    if (!streamUrl) continue;
    if (tr.format.protocol === "progressive") {
      const up = await fetch(streamUrl, { headers: hdr(token) });
      if (up.ok && up.body) return new Response(up.body, { headers: metaHeaders(track, "audio/mpeg") });
    } else {
      return concatHls(streamUrl, track, "audio/mpeg", token);
    }
  }
  throw new Error("DRM"); // ничего незащищённого нет
}

// ---------- SoundCloud «как клиент» ----------
function needToken(token) {
  if (!token) throw new Error("NEED_LOGIN");
}

async function scMe(token) {
  needToken(token);
  const me = await scApi("/me", token);
  return json({
    id: me.id,
    username: me.username,
    avatar: (me.avatar_url || "").replace("-large.", "-t200x200."),
  });
}

async function scLikes(token, sp) {
  needToken(token);
  const offset = parseInt(sp.get("offset") || "0", 10) || 0;
  const limit = Math.min(parseInt(sp.get("limit") || "30", 10) || 30, 50);
  const me = await scApi("/me", token);
  const d = await scApi(`/users/${me.id}/track_likes?limit=${limit}&offset=${offset}&linked_partitioning=1`, token);
  const items = (d.collection || []).filter((x) => x.track).map((x) => trackBrief(x.track));
  return json({ items, next_offset: d.next_href ? offset + limit : null });
}

async function scPlaylists(token) {
  needToken(token);
  const me = await scApi("/me", token);
  const d = await scApi(`/users/${me.id}/playlists?limit=50&linked_partitioning=1`, token);
  const items = (d.collection || []).map((p) => ({
    id: p.id,
    title: p.title,
    track_count: p.track_count,
    thumbnail: (p.artwork_url || "").replace("-large.", "-t500x500."),
  }));
  return json({ items });
}

async function scPlaylist(token, sp) {
  const id = sp.get("id");
  if (!id) return err("нет id");
  const pl = await scApi(`/playlists/${encodeURIComponent(id)}`, token);
  const tracks = pl.tracks || [];
  const full = tracks.filter((t) => t.title);
  const thin = tracks.filter((t) => !t.title).map((t) => t.id);
  for (let i = 0; i < thin.length; i += 50) {  // «тонкие» записи догружаем пачками
    const got = await scApi(`/tracks?ids=${thin.slice(i, i + 50).join(",")}`, token);
    if (Array.isArray(got)) full.push(...got);
  }
  const order = new Map(tracks.map((t, i) => [t.id, i]));
  full.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  return json({ title: pl.title, items: full.map(trackBrief) });
}

async function scSearch(token, sp) {
  const q = (sp.get("q") || "").trim();
  if (!q) return err("пустой запрос");
  const limit = Math.min(parseInt(sp.get("limit") || "25", 10) || 25, 50);
  const d = await scApi(`/search/tracks?q=${encodeURIComponent(q)}&limit=${limit}`, token);
  return json({ items: (d.collection || []).map(trackBrief) });
}

async function handleApi(route, url, token) {
  const sp = url.searchParams;
  const target = sp.get("url") || "";

  if (route === "sc/me") return scMe(token);
  if (route === "sc/likes") return scLikes(token, sp);
  if (route === "sc/playlists") return scPlaylists(token);
  if (route === "sc/playlist") return scPlaylist(token, sp);
  if (route === "sc/search") return scSearch(token, sp);

  if (route === "thumb") {
    if (!target) return err("нет url");
    const r = await fetch(target, { headers: H });
    if (!r.ok) return err("обложка недоступна " + r.status);
    return new Response(r.body, {
      headers: {
        "Content-Type": r.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  if (!target) return err("нет ссылки");
  if (isYouTube(target)) {
    return err(
      "YouTube недоступен в Cloudflare-версии (антибот режет serverless). " +
        "Для YouTube нужна версия с yt-dlp (см. README).",
      422
    );
  }
  if (!/soundcloud\.com/i.test(target)) return err("Пока поддерживается только SoundCloud");

  const track = await resolveTrack(target, token);

  if (route === "info") {
    return json({ ...trackBrief(track), source: "Soundcloud", webpage_url: track.permalink_url });
  }
  if (route === "download") return download(track, token);

  return err("неизвестный маршрут", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const route = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
      // быстрый 404 для неизвестных маршрутов (клиент по нему понимает, что фоновых заданий нет)
      if (!ROUTES.includes(route)) return err("неизвестный маршрут", 404);
      const token = (request.headers.get("X-SC-Token") || "").trim();
      try {
        return await handleApi(route, url, token);
      } catch (e) {
        const m = e?.message || String(e);
        if (m === "NEED_LOGIN") return err("Нужен вход в SoundCloud — добавь токен в настройках", 401);
        if (m === "TOKEN") return err("SoundCloud не принял токен — обнови его в настройках", 401);
        if (m === "NOT_FOUND") return err("Трек не найден — ссылка битая, приватная или удалена", 404);
        if (m === "DRM") return err("Этот трек защищён SoundCloud (DRM) — скачать нельзя. Попробуй другой.", 422);
        return err("Ошибка: " + m, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
