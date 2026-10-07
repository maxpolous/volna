// Cloudflare Pages Function — «качалка» на чистом JS (без Python/ffmpeg).
// Маршруты: /api/info, /api/download, /api/thumb
// SoundCloud работает полностью. YouTube на serverless капризен — даём понятную ошибку.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";

let CLIENT_ID = null; // кэшируем в пределах живого isolate

async function getClientId(force = false) {
  if (CLIENT_ID && !force) return CLIENT_ID;
  const html = await (await fetch("https://soundcloud.com/", { headers: { "User-Agent": UA } })).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => u.includes("sndcdn.com/assets"));
  for (const url of scripts.reverse()) {
    const js = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
    const m = js.match(/client_id:"([a-zA-Z0-9]{20,})"/) || js.match(/client_id=([a-zA-Z0-9]{20,})/);
    if (m) {
      CLIENT_ID = m[1];
      return CLIENT_ID;
    }
  }
  throw new Error("SoundCloud client_id не найден");
}

async function scApi(path) {
  // path уже с ?… ; добавим client_id, при 401 обновим id и повторим
  let cid = await getClientId();
  let r = await fetch(`https://api-v2.soundcloud.com${path}&client_id=${cid}`, {
    headers: { "User-Agent": UA },
  });
  if (r.status === 401) {
    cid = await getClientId(true);
    r = await fetch(`https://api-v2.soundcloud.com${path}&client_id=${cid}`, {
      headers: { "User-Agent": UA },
    });
  }
  if (!r.ok) throw new Error("SoundCloud API " + r.status);
  return r.json();
}

async function resolveTrack(url) {
  const data = await scApi(`/resolve?url=${encodeURIComponent(url)}`);
  if (data.kind === "playlist" && Array.isArray(data.tracks) && data.tracks.length) {
    // плейлист — берём первый трек (может быть «тонким», до-резолвим по id)
    const first = data.tracks[0];
    if (!first.media) return scApi(`/tracks/${first.id}?`);
    return first;
  }
  if (data.kind !== "track") throw new Error("Это не трек SoundCloud");
  return data;
}

function bigArt(track) {
  const a = track.artwork_url || track.user?.avatar_url || "";
  return a ? a.replace("-large.", "-t500x500.") : "";
}

function pickTranscoding(track) {
  const ts = track.media?.transcodings || [];
  return (
    ts.find((t) => t.format?.protocol === "progressive" && /mpeg/.test(t.format?.mime_type)) ||
    ts.find((t) => t.format?.protocol === "progressive") ||
    ts.find((t) => t.format?.protocol === "hls" && /mpeg/.test(t.format?.mime_type)) ||
    ts.find((t) => t.format?.protocol === "hls") ||
    ts[0]
  );
}

function metaHeaders(track, mime) {
  const q = encodeURIComponent;
  return {
    "Content-Type": mime,
    "X-Title": q(track.title || "Без названия"),
    "X-Uploader": q(track.user?.username || ""),
    "X-Duration": String(Math.round((track.duration || 0) / 1000)),
    "X-Thumbnail": q(bigArt(track)),
    "X-Track-Id": q(String(track.id || "")),
    "X-Source": "Soundcloud",
    "Access-Control-Expose-Headers":
      "X-Title,X-Uploader,X-Duration,X-Thumbnail,X-Track-Id,X-Source",
  };
}

function isYouTube(u) {
  return /(^|\.)youtube\.com|youtu\.be/i.test(u);
}

function err(msg, code = 400) {
  return new Response(JSON.stringify({ detail: msg }), {
    status: code,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function streamProgressive(track, cid, tr) {
  const meta = await (
    await fetch(tr.url + "?client_id=" + cid, { headers: { "User-Agent": UA } })
  ).json();
  const up = await fetch(meta.url, { headers: { "User-Agent": UA } });
  if (!up.ok || !up.body) throw new Error("Поток недоступен " + up.status);
  return new Response(up.body, { headers: metaHeaders(track, "audio/mpeg") });
}

async function downloadHls(track, cid, tr) {
  const meta = await (
    await fetch(tr.url + "?client_id=" + cid, { headers: { "User-Agent": UA } })
  ).json();
  const m3u8 = await (await fetch(meta.url, { headers: { "User-Agent": UA } })).text();
  const segs = m3u8.split("\n").filter((l) => l && !l.startsWith("#"));
  if (!segs.length) throw new Error("Пустой HLS-плейлист");
  const parts = [];
  for (const s of segs) {
    const b = await (await fetch(s, { headers: { "User-Agent": UA } })).arrayBuffer();
    parts.push(new Uint8Array(b));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  const mime = /mpeg/.test(tr.format?.mime_type) ? "audio/mpeg" : "audio/aac";
  return new Response(out, { headers: metaHeaders(track, mime) });
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\//, "");
  const target = url.searchParams.get("url") || "";

  try {
    if (route === "thumb") {
      if (!target) return err("нет url");
      const r = await fetch(target, { headers: { "User-Agent": UA } });
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
        "YouTube недоступен в бесплатном Cloudflare-режиме (его антибот блокирует " +
          "serverless). Используй SoundCloud. YouTube можно включить в Mac-режиме.",
        422
      );
    }
    if (!/soundcloud\.com/i.test(target)) {
      return err("Пока поддерживается только SoundCloud");
    }

    const track = await resolveTrack(target);

    if (route === "info") {
      return new Response(
        JSON.stringify({
          id: track.id,
          title: track.title,
          uploader: track.user?.username,
          duration: Math.round((track.duration || 0) / 1000),
          thumbnail: bigArt(track),
          source: "Soundcloud",
          webpage_url: track.permalink_url,
        }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    if (route === "download") {
      const cid = await getClientId();
      const tr = pickTranscoding(track);
      if (!tr) return err("Нет доступного аудиопотока");
      if (tr.format?.protocol === "progressive") return streamProgressive(track, cid, tr);
      return downloadHls(track, cid, tr);
    }

    return err("неизвестный маршрут", 404);
  } catch (e) {
    return err("Ошибка: " + (e?.message || e), 500);
  }
}
