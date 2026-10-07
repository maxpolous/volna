/* Волна — клиентская логика: библиотека в IndexedDB, плеер, Media Session. */

const $ = (s) => document.querySelector(s);
const API = ""; // тот же origin, что и приложение

/* ---------- IndexedDB ---------- */
const DB_NAME = "volna";
const STORE = "tracks";
let _db;

function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
function tx(mode) { return db().then((d) => d.transaction(STORE, mode).objectStore(STORE)); }
function idbGetAll() {
  return tx("readonly").then((s) => new Promise((res, rej) => {
    const r = s.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
  }));
}
function idbGet(id) {
  return tx("readonly").then((s) => new Promise((res, rej) => {
    const r = s.get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
function idbPut(rec) {
  return tx("readwrite").then((s) => new Promise((res, rej) => {
    const r = s.put(rec); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }));
}
function idbDel(id) {
  return tx("readwrite").then((s) => new Promise((res, rej) => {
    const r = s.delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }));
}

/* ---------- утилиты ---------- */
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}
function decodeHeader(v) { try { return decodeURIComponent(v || ""); } catch { return v || ""; } }
function setStatus(msg, kind) {
  const el = $("#status");
  if (!msg) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false; el.className = "status" + (kind ? " " + kind : "");
  el.innerHTML = (kind === "load" ? '<span class="spin"></span>' : "") + "<span></span>";
  el.querySelector("span:last-child").textContent = msg;
}

/* ---------- состояние ---------- */
let library = [];       // [{id,title,uploader,duration,mime,addedAt,hasThumb}]
let queue = [];         // массив id в порядке списка
let currentId = null;
let currentUrlObj = null; // objectURL текущего аудио
let artUrlObj = null;     // objectURL текущей обложки
const audio = $("#audio");

/* ---------- добавление трека ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let directDownload = false; // true, если бэкенд без фоновых заданий (Cloudflare Worker)

async function httpError(resp) {
  if (resp.status === 503) return new Error("Сервер просыпается (~1 мин) — попробуй ещё раз");
  let detail = resp.status;
  try { detail = (await resp.json()).detail || detail; } catch {}
  return new Error(detail);
}

// fetch с таймаутом: без него запрос к недоступному серверу висит вечно («Подключаюсь…»).
// onSlow дёргается через 6 с — показать подсказку, пока ещё ждём.
async function fetchT(url, ms, onSlow) {
  const ac = new AbortController();
  const slow = onSlow ? setTimeout(onSlow, 6000) : null;
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal, headers: apiHeaders() }); }
  finally { clearTimeout(t); if (slow) clearTimeout(slow); }
}

// Качаем через фоновое задание (/api/start -> /api/status -> /api/file): долгий одиночный
// запрос прокси рвёт («Load failed»). Если бэкенд без заданий (404) — качаем напрямую.
async function fetchAudio(url) {
  const enc = encodeURIComponent(url);
  if (!directDownload) {
    const st = await fetchT(API + "/api/start?url=" + enc, 60000, () =>
      setStatus("Сервер долго не отвечает (спит или сеть до него) — жду до минуты…", "load"));
    if (st.status === 404) {
      directDownload = true;
    } else {
      if (!st.ok) throw await httpError(st);
      const { id } = await st.json();
      for (;;) {
        await sleep(1500);
        const sr = await fetchT(API + "/api/status?id=" + id, 20000);
        if (!sr.ok) throw await httpError(sr);
        const s = await sr.json();
        if (s.state === "error") throw new Error(s.error || "ошибка загрузки");
        if (s.state === "done") break;
        const pct = s.progress != null ? " " + s.progress + "%" : "";
        const label =
          s.state === "converting" ? "Конвертирую…" :
          s.state === "downloading" ? "Качаю…" + pct : "Готовлю…";
        setStatus(label + (s.title ? " · " + s.title : ""), "load");
      }
      return fetch(API + "/api/file?id=" + id);
    }
  }
  return fetch(API + "/api/download?url=" + enc, { headers: apiHeaders() });
}

// После скачивания: «Готово» + кнопка «Сохранить в Файлы…» (iOS открывает меню «Поделиться»,
// где сам выбираешь папку/приложение). Автоматически открыть нельзя — iOS требует тап.
function showDoneWithSave(id, title) {
  const el = $("#status");
  el.hidden = false;
  el.className = "status ok";
  el.innerHTML =
    '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>' +
    '<button type="button" style="flex:0 0 auto;border:0;border-radius:10px;padding:8px 12px;' +
    'font-size:14px;font-weight:600;color:#fff;background:linear-gradient(135deg,#ff5500,#ff8a00);' +
    'cursor:pointer">Сохранить в Файлы…</button>';
  el.querySelector("span").textContent = "Готово: " + title;
  el.querySelector("button").onclick = () => shareTrack(id);
}

async function addTrack(url) {
  url = (url || "").trim();
  if (!/^https?:\/\//i.test(url)) { setStatus("Это не похоже на ссылку", "err"); return; }
  $("#addBtn").disabled = true;
  setStatus("Подключаюсь…", "load");
  try {
    const resp = await fetchAudio(url);
    if (!resp.ok) throw await httpError(resp);
    const title = decodeHeader(resp.headers.get("X-Title")) || "Без названия";
    const uploader = decodeHeader(resp.headers.get("X-Uploader"));
    const duration = parseInt(resp.headers.get("X-Duration") || "0", 10);
    const thumbUrl = decodeHeader(resp.headers.get("X-Thumbnail"));
    const srcId = decodeHeader(resp.headers.get("X-Track-Id"));
    const source = decodeHeader(resp.headers.get("X-Source"));
    const mime = resp.headers.get("Content-Type") || "audio/mp4";
    const audioBlob = await resp.blob();

    const id = (source || "x") + ":" + (srcId || Date.now());

    // обложка — тянем через прокси, чтобы сохранить офлайн
    let thumbBlob = null;
    if (thumbUrl) {
      try {
        const tr = await fetch(API + "/api/thumb?url=" + encodeURIComponent(thumbUrl));
        if (tr.ok) thumbBlob = await tr.blob();
      } catch {}
    }

    const rec = {
      id, title, uploader, duration, mime, source,
      addedAt: Date.now(), audioBlob, thumbBlob,
    };
    await idbPut(rec);
    $("#url").value = "";
    await refresh();
    showDoneWithSave(id, title);
  } catch (e) {
    // AbortError = наш таймаут; TypeError от fetch («Load failed») = сеть/обрыв
    const msg = (e && e.name === "AbortError")
      ? "Сервер не ответил за минуту. Проверь в Safari: " + location.origin + "/healthz — " +
        "если не открывается, это сеть/VPN до сервера"
      : e instanceof TypeError
        ? "Нет связи с сервером (возможно, он просыпается ~1 мин) — попробуй ещё раз"
        : e.message;
    setStatus("Не вышло: " + msg, "err");
  } finally {
    $("#addBtn").disabled = false;
  }
}

/* ---------- отрисовка списка ---------- */
async function refresh() {
  library = await idbGetAll();
  library.sort((a, b) => b.addedAt - a.addedAt);
  queue = library.map((t) => t.id);
  const list = $("#list");
  list.innerHTML = "";
  $("#empty").hidden = library.length > 0;

  for (const t of library) {
    const li = document.createElement("li");
    li.className = "row" + (t.id === currentId ? " active playing" : "");
    li.dataset.id = t.id;

    let art;
    if (t.thumbBlob) {
      art = document.createElement("img");
      art.className = "art";
      art.src = URL.createObjectURL(t.thumbBlob);
      art.loading = "lazy";
    } else {
      art = document.createElement("div");
      art.className = "art art-ph";
      art.innerHTML = '<svg viewBox="0 0 24 24"><use href="#note"/></svg>';
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML =
      '<div class="t-title"></div><div class="t-sub"></div>';
    meta.querySelector(".t-title").textContent = t.title;
    meta.querySelector(".t-sub").textContent =
      [t.uploader, fmtTime(t.duration)].filter(Boolean).join(" · ");

    const eq = document.createElement("div");
    eq.className = "eq"; eq.innerHTML = "<i></i><i></i><i></i>";

    const actions = document.createElement("div");
    actions.className = "row-actions";
    const shareBtn = document.createElement("button");
    shareBtn.setAttribute("aria-label", "Сохранить в Файлы");
    shareBtn.innerHTML = '<svg viewBox="0 0 24 24"><use href="#share"/></svg>';
    shareBtn.onclick = (e) => { e.stopPropagation(); shareTrack(t.id); };
    const delBtn = document.createElement("button");
    delBtn.setAttribute("aria-label", "Удалить");
    delBtn.innerHTML = '<svg viewBox="0 0 24 24"><use href="#trash"/></svg>';
    delBtn.onclick = (e) => { e.stopPropagation(); removeTrack(t.id); };
    actions.append(shareBtn, delBtn);

    li.append(art, eq, meta, actions);
    li.onclick = () => playById(t.id);
    list.append(li);
  }
  markPlayingRow();
  markScRows(); // галочки «уже в библиотеке» во вкладках SoundCloud
}

/* ---------- плеер ---------- */
async function playById(id) {
  const rec = await idbGet(id);
  if (!rec) return;
  if (currentUrlObj) URL.revokeObjectURL(currentUrlObj);
  if (artUrlObj) { URL.revokeObjectURL(artUrlObj); artUrlObj = null; }
  currentUrlObj = URL.createObjectURL(rec.audioBlob);
  currentId = id;
  audio.src = currentUrlObj;
  audio.play().catch(() => {});
  $("#player").hidden = false;
  $("#pTitle").textContent = rec.title;
  $("#pSub").textContent = rec.uploader || "";
  if (rec.thumbBlob) {
    artUrlObj = URL.createObjectURL(rec.thumbBlob);
    $("#pArt").style.backgroundImage = "url(" + artUrlObj + ")";
  } else {
    $("#pArt").style.backgroundImage = "none";
  }
  setMediaSession(rec);
  markPlayingRow();
}
function markPlayingRow() {
  document.querySelectorAll(".row").forEach((r) => {
    const on = r.dataset.id === currentId;
    r.classList.toggle("active", on);
    r.classList.toggle("playing", on && !audio.paused);
  });
}
function curIndex() { return queue.indexOf(currentId); }
function playNext() { const i = curIndex(); if (i > -1 && i < queue.length - 1) playById(queue[i + 1]); }
function playPrev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const i = curIndex(); if (i > 0) playById(queue[i - 1]);
}
function togglePlay() {
  if (!currentId && queue.length) { playById(queue[0]); return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
function setPlayIcon() {
  $("#play").innerHTML = '<svg viewBox="0 0 24 24"><use href="#' + (audio.paused ? "play" : "pause") + '"/></svg>';
}

audio.addEventListener("play", () => { setPlayIcon(); markPlayingRow(); updatePositionState(); });
audio.addEventListener("pause", () => { setPlayIcon(); markPlayingRow(); });
audio.addEventListener("ended", playNext);
audio.addEventListener("timeupdate", () => {
  if (!audio.duration) return;
  $("#seek").value = Math.round((audio.currentTime / audio.duration) * 1000);
  $("#cur").textContent = fmtTime(audio.currentTime);
  $("#dur").textContent = fmtTime(audio.duration);
});
audio.addEventListener("loadedmetadata", () => { $("#dur").textContent = fmtTime(audio.duration); });
$("#seek").addEventListener("input", (e) => {
  if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration;
});

/* ---------- Media Session (экран блокировки / Пункт управления) ---------- */
function setMediaSession(rec) {
  if (!("mediaSession" in navigator)) return;
  const artwork = [];
  if (rec.thumbBlob) {
    const u = URL.createObjectURL(rec.thumbBlob);
    artwork.push({ src: u, sizes: "512x512", type: rec.thumbBlob.type || "image/jpeg" });
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: rec.title || "Волна",
    artist: rec.uploader || "",
    album: "Волна",
    artwork,
  });
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", playPrev);
  navigator.mediaSession.setActionHandler("nexttrack", playNext);
  try {
    navigator.mediaSession.setActionHandler("seekto", (d) => {
      if (d.seekTime != null) audio.currentTime = d.seekTime;
    });
  } catch {}
}
function updatePositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  if (audio.duration && isFinite(audio.duration)) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration, position: audio.currentTime, playbackRate: 1,
      });
    } catch {}
  }
}
setInterval(updatePositionState, 1000);

/* ---------- удалить / сохранить в Файлы ---------- */
async function removeTrack(id) {
  const rec = await idbGet(id);
  if (!rec) return;
  if (!confirm('Удалить «' + rec.title + '» из библиотеки?')) return;
  if (id === currentId) { audio.pause(); audio.removeAttribute("src"); audio.load(); currentId = null; $("#player").hidden = true; }
  await idbDel(id);
  await refresh();
}
async function shareTrack(id) {
  const rec = await idbGet(id);
  if (!rec) return;
  const ext = (rec.mime || "").includes("mpeg") ? "mp3" : "m4a";
  const safe = (rec.title || "track").replace(/[\/\\:*?"<>|]+/g, " ").slice(0, 80).trim();
  const file = new File([rec.audioBlob], safe + "." + ext, { type: rec.mime || "audio/mp4" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: rec.title }); return; } catch { return; }
  }
  // запасной путь — обычное скачивание
  const u = URL.createObjectURL(rec.audioBlob);
  const a = document.createElement("a");
  a.href = u; a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
}

/* ---------- кнопки / форма ---------- */
$("#addForm").addEventListener("submit", (e) => { e.preventDefault(); addTrack($("#url").value); });
$("#play").addEventListener("click", togglePlay);
$("#prev").addEventListener("click", playPrev);
$("#next").addEventListener("click", playNext);
$("#pasteBtn").addEventListener("click", async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (t) { $("#url").value = t.trim(); addTrack(t); }
  } catch { setStatus("Не дал доступ к буферу — вставь вручную", "err"); }
});
$("#storageBtn").addEventListener("click", async () => {
  let msg = "Треков: " + library.length;
  if (navigator.storage && navigator.storage.estimate) {
    const e = await navigator.storage.estimate();
    msg += " · занято ~" + (e.usage / 1048576).toFixed(0) + " МБ";
    if (e.quota) msg += " из ~" + (e.quota / 1048576).toFixed(0) + " МБ";
  }
  setStatus(msg, "ok");
  setTimeout(() => setStatus(""), 4000);
});

/* ---------- приём ссылки из «Поделиться» (share_target через ?url=) ---------- */
function handleIncoming() {
  const p = new URLSearchParams(location.search);
  // вход по ссылке ?token=… (закладка «Волна: войти» на soundcloud.com)
  const tok = p.get("token");
  if (tok) {
    try { localStorage.setItem(SC_TOKEN_KEY, tok.trim()); } catch {}
    history.replaceState({}, "", location.pathname);
    likesItems = [];
    openSettings(true);
    verifyToken();
    return;
  }
  const shared = p.get("url") || p.get("text");
  if (shared && /^https?:\/\//i.test(shared.trim())) {
    $("#url").value = shared.trim();
    addTrack(shared);
    history.replaceState({}, "", location.pathname);
  }
}

/* ---------- SoundCloud «как клиент»: токен, вкладки, лайки, плейлисты, поиск ---------- */
const SC_TOKEN_KEY = "volna.scToken";
function scToken() { try { return localStorage.getItem(SC_TOKEN_KEY) || ""; } catch { return ""; } }
function apiHeaders() { const t = scToken(); return t ? { "X-SC-Token": t } : {}; }

async function apiJson(path, timeoutMs) {
  const r = await fetchT(API + path, timeoutMs || 25000);
  if (!r.ok) throw await httpError(r);
  return r.json();
}

function libraryHas(scId) { return library.some((t) => t.id === "Soundcloud:" + scId); }

function noteRow(ul, text, btnLabel, onBtn) {
  ul.innerHTML = "";
  const li = document.createElement("li");
  li.className = "need-login";
  li.innerHTML = "<p></p>";
  li.querySelector("p").textContent = text;
  if (btnLabel) {
    const b = document.createElement("button");
    b.className = "btn"; b.type = "button"; b.textContent = btnLabel; b.onclick = onBtn;
    li.append(b);
  }
  ul.append(li);
}
function renderNeedLogin(ul) {
  noteRow(ul, "Чтобы видеть свои лайки и плейлисты, войди в SoundCloud.", "Открыть настройки", () => openSettings(true));
}

// Строки треков SoundCloud: тап = скачать; DRM — замок; уже скачанные — галочка
function renderScRows(ul, items, emptyText) {
  ul.innerHTML = "";
  if (!items.length) { noteRow(ul, emptyText || "Пусто"); return; }
  for (const t of items) {
    const li = document.createElement("li");
    li.className = "row sc-row" + (t.drm ? " drm" : "");
    li.dataset.scid = t.id;
    let art;
    if (t.thumbnail) {
      art = document.createElement("img");
      art.className = "art"; art.src = t.thumbnail; art.loading = "lazy"; art.referrerPolicy = "no-referrer";
    } else {
      art = document.createElement("div");
      art.className = "art art-ph";
      art.innerHTML = '<svg viewBox="0 0 24 24"><use href="#note"/></svg>';
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = '<div class="t-title"></div><div class="t-sub"></div>';
    meta.querySelector(".t-title").textContent = t.title || "Без названия";
    meta.querySelector(".t-sub").textContent = [t.uploader, fmtTime(t.duration)].filter(Boolean).join(" · ");
    const act = document.createElement("div");
    act.className = "row-actions sc-act";
    li.append(art, meta, act);
    li.onclick = () => {
      if (t.drm) { setStatus("Этот трек защищён SoundCloud (DRM) — скачать нельзя", "err"); return; }
      if (t.url) addTrack(t.url);
    };
    ul.append(li);
  }
  markScRows();
}

function markScRows() {
  document.querySelectorAll(".sc-row").forEach((li) => {
    const act = li.querySelector(".sc-act");
    if (!act) return;
    if (li.classList.contains("drm")) {
      act.innerHTML = '<span class="badge lock" title="Защищён DRM — скачать нельзя"><svg viewBox="0 0 24 24"><use href="#lock"/></svg></span>';
    } else if (libraryHas(li.dataset.scid)) {
      act.innerHTML = '<span class="badge ok" title="Уже в библиотеке"><svg viewBox="0 0 24 24"><use href="#check"/></svg></span>';
    } else {
      act.innerHTML = '<span class="badge dl" title="Скачать"><svg viewBox="0 0 24 24"><use href="#download"/></svg></span>';
    }
  });
}

// --- Лайки (с подгрузкой «Ещё») ---
let likesOffset = 0, likesItems = [];
async function loadLikes(reset) {
  const ul = $("#likesList"), more = $("#likesMore");
  if (!scToken()) { renderNeedLogin(ul); more.hidden = true; return; }
  if (reset) { likesOffset = 0; likesItems = []; noteRow(ul, "Загружаю…"); }
  try {
    const d = await apiJson("/api/sc/likes?offset=" + likesOffset + "&limit=30");
    likesItems = likesItems.concat(d.items || []);
    renderScRows(ul, likesItems, "Лайков пока нет");
    if (d.next_offset != null) { likesOffset = d.next_offset; more.hidden = false; } else { more.hidden = true; }
  } catch (e) {
    noteRow(ul, "Не вышло: " + e.message); more.hidden = true;
  }
}

// --- Плейлисты -> треки плейлиста ---
async function loadPlaylists() {
  const ul = $("#plList");
  $("#plHead").hidden = true;
  if (!scToken()) { renderNeedLogin(ul); return; }
  noteRow(ul, "Загружаю…");
  try {
    const d = await apiJson("/api/sc/playlists");
    const items = d.items || [];
    if (!items.length) { noteRow(ul, "Плейлистов нет"); return; }
    ul.innerHTML = "";
    for (const p of items) {
      const li = document.createElement("li");
      li.className = "row";
      let art;
      if (p.thumbnail) { art = document.createElement("img"); art.className = "art"; art.src = p.thumbnail; art.loading = "lazy"; art.referrerPolicy = "no-referrer"; }
      else { art = document.createElement("div"); art.className = "art art-ph"; art.innerHTML = '<svg viewBox="0 0 24 24"><use href="#note"/></svg>'; }
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = '<div class="t-title"></div><div class="t-sub"></div>';
      meta.querySelector(".t-title").textContent = p.title || "Плейлист";
      meta.querySelector(".t-sub").textContent = p.track_count != null ? p.track_count + " тр." : "";
      li.append(art, meta);
      li.onclick = () => loadPlaylist(p.id, p.title);
      ul.append(li);
    }
  } catch (e) { noteRow(ul, "Не вышло: " + e.message); }
}
async function loadPlaylist(id, title) {
  const ul = $("#plList");
  $("#plHead").hidden = false;
  $("#plTitle").textContent = title || "";
  noteRow(ul, "Загружаю…");
  try {
    const d = await apiJson("/api/sc/playlist?id=" + encodeURIComponent(id), 40000);
    renderScRows(ul, d.items || [], "В плейлисте пусто");
  } catch (e) { noteRow(ul, "Не вышло: " + e.message); }
}
$("#plBack").addEventListener("click", loadPlaylists);

// --- Поиск (работает и без входа) ---
$("#searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (!q) return;
  const ul = $("#searchList");
  noteRow(ul, "Ищу…");
  try {
    const d = await apiJson("/api/sc/search?q=" + encodeURIComponent(q));
    renderScRows(ul, d.items || [], "Ничего не нашлось");
  } catch (err) { noteRow(ul, "Не вышло: " + err.message); }
  $("#q").blur();
});

// --- Вкладки ---
function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => { p.hidden = p.id !== "panel-" + name; });
  try { localStorage.setItem("volna.tab", name); } catch {}
  if (name === "likes" && !likesItems.length) loadLikes(true);
  if (name === "playlists") loadPlaylists();
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (b) showTab(b.dataset.tab);
});
$("#likesMore").addEventListener("click", () => loadLikes(false));

// --- Настройки / токен ---
function openSettings(show) {
  const s = $("#settings");
  s.hidden = show === undefined ? !s.hidden : !show;
  if (!s.hidden) $("#tokenInput").value = scToken();
}
async function verifyToken() {
  const st = $("#tokenState");
  if (!scToken()) { st.textContent = "Вход не выполнен"; st.className = "s-state"; return false; }
  st.textContent = "Проверяю…"; st.className = "s-state";
  try {
    const me = await apiJson("/api/sc/me", 20000);
    st.textContent = "Вошёл как " + (me.username || "?"); st.className = "s-state ok";
    return true;
  } catch (e) {
    st.textContent = "Токен не принят: " + e.message; st.className = "s-state err";
    return false;
  }
}
$("#settingsBtn").addEventListener("click", () => openSettings());
$("#tokenSave").addEventListener("click", async () => {
  const t = $("#tokenInput").value.trim();
  try { if (t) localStorage.setItem(SC_TOKEN_KEY, t); else localStorage.removeItem(SC_TOKEN_KEY); } catch {}
  likesItems = [];
  if (await verifyToken()) { $("#likesList").innerHTML = ""; $("#plList").innerHTML = ""; }
});
$("#tokenClear").addEventListener("click", () => {
  try { localStorage.removeItem(SC_TOKEN_KEY); } catch {}
  $("#tokenInput").value = "";
  likesItems = [];
  $("#likesList").innerHTML = ""; $("#plList").innerHTML = "";
  verifyToken();
});

/* ---------- старт ---------- */
(async function init() {
  setPlayIcon();
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch {}
  }
  await refresh();
  let savedTab = "lib";
  try { savedTab = localStorage.getItem("volna.tab") || "lib"; } catch {}
  showTab(savedTab);
  if (scToken()) verifyToken();
  // код закладки-входа: на soundcloud.com читает cookie oauth_token и возвращает сюда с ?token=
  const appUrl = location.origin + location.pathname.replace(/[^/]*$/, "");
  const bm = "javascript:(()=>{var m=document.cookie.match(/(?:^|;\\s*)oauth_token=([^;]+)/);" +
    "if(!m){alert('Не нашёл oauth_token — ты вошёл в SoundCloud?');return;}" +
    "location.href=" + JSON.stringify(appUrl) + "+'?token='+encodeURIComponent(m[1]);})();";
  $("#bmCode").value = bm;
  $("#bmCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(bm); setStatus("Код закладки скопирован", "ok"); }
    catch { $("#bmCode").select(); setStatus("Выдели и скопируй код вручную", "err"); }
  });
  handleIncoming();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
