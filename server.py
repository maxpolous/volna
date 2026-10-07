"""
Волна — бэкенд-«качалка».

Эндпоинты:
  GET /api/info?url=...      -> метаданные (title, uploader, duration, thumbnail)
  GET /api/download?url=...  -> аудио-файл (m4a), метаданные в заголовках X-*
  GET /api/thumb?url=...      -> прокси обложки (чтобы телефон мог сохранить её офлайн)
  /                          -> отдаёт PWA из ./static

yt-dlp качает только аудио и конвертит в m4a (AAC) — формат, который гарантированно
играет в Safari на iOS. Файлы хранятся на телефоне (IndexedDB), сервер ничего не хранит.
"""

import io
import os
import re
import shutil
import tempfile
import threading
import time
import urllib.parse
import uuid

import httpx
import yt_dlp
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

try:
    from PIL import Image  # для уменьшения обложек
except Exception:  # noqa: BLE001
    Image = None

app = FastAPI(title="Волна")

EXT_MIME = {
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "mp3": "audio/mpeg",
    "aac": "audio/aac",
    "opus": "audio/opus",
    "ogg": "audio/ogg",
    "webm": "audio/webm",
}

# Необязательный файл cookies (Netscape-формат) чинит YouTube в облаке:
#   положи cookies.txt рядом с server.py ИЛИ укажи путь в переменной COOKIES_FILE,
#   ИЛИ (для HF Spaces) положи содержимое файла в секрет YT_COOKIES — запишем его в /tmp.
COOKIES_FILE = os.environ.get("COOKIES_FILE", "cookies.txt")
if os.environ.get("YT_COOKIES"):
    COOKIES_FILE = "/tmp/cookies.txt"
    with open(COOKIES_FILE, "w", encoding="utf-8") as _f:
        _f.write(os.environ["YT_COOKIES"])

BASE_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    # немного маскируемся под обычный клиент, помогает с частью площадок
    "http_headers": {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
        )
    },
    "retries": 3,
    "socket_timeout": 30,
}
if os.path.exists(COOKIES_FILE):
    BASE_OPTS["cookiefile"] = COOKIES_FILE


def _download_opts(outdir: str, token: str | None = None) -> dict:
    opts = dict(BASE_OPTS)
    if token:  # вход в SoundCloud как пользователь (yt-dlp: username=oauth, password=токен)
        opts["username"] = "oauth"
        opts["password"] = token
    opts.update(
        {
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": os.path.join(outdir, "%(id)s.%(ext)s"),
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "m4a",
                    "preferredquality": "192",
                }
            ],
        }
    )
    return opts


def _pick_thumb(info: dict) -> str:
    """Выбираем обложку среднего размера (~500px), а не гигантский оригинал."""
    thumbs = info.get("thumbnails") or []
    sized = [t for t in thumbs if t.get("url") and t.get("width")]
    if sized:
        # ближайшая к 500px по ширине
        best = min(sized, key=lambda t: abs(int(t["width"]) - 500))
        return best["url"]
    return info.get("thumbnail") or ""


def _meta_headers(info: dict) -> dict:
    q = urllib.parse.quote
    return {
        "X-Title": q(info.get("title") or "Без названия"),
        "X-Uploader": q(info.get("uploader") or info.get("channel") or ""),
        "X-Duration": str(int(info.get("duration") or 0)),
        "X-Thumbnail": q(_pick_thumb(info)),
        "X-Track-Id": q(str(info.get("id") or "")),
        "X-Source": q(info.get("extractor_key") or ""),
        "X-Webpage-Url": q(info.get("webpage_url") or ""),
        "Access-Control-Expose-Headers": (
            "X-Title,X-Uploader,X-Duration,X-Thumbnail,"
            "X-Track-Id,X-Source,X-Webpage-Url"
        ),
    }


@app.get("/api/info")
def info(
    url: str = Query(..., min_length=4),
    token: str | None = Header(None, alias="X-SC-Token"),
):
    try:
        opts = {**BASE_OPTS, "skip_download": True}
        if token:
            opts.update(username="oauth", password=token)
        with yt_dlp.YoutubeDL(opts) as ydl:
            i = ydl.extract_info(url, download=False)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Не удалось получить данные: {e}")

    # плейлист -> берём первый трек
    if i.get("_type") == "playlist" and i.get("entries"):
        i = i["entries"][0]

    return {
        "id": i.get("id"),
        "title": i.get("title"),
        "uploader": i.get("uploader") or i.get("channel"),
        "duration": i.get("duration"),
        "thumbnail": _pick_thumb(i),
        "source": i.get("extractor_key"),
        "webpage_url": i.get("webpage_url"),
    }


@app.get("/api/download")
def download(
    url: str = Query(..., min_length=4),
    token: str | None = Header(None, alias="X-SC-Token"),
):
    tmp = tempfile.mkdtemp(prefix="volna_")
    try:
        with yt_dlp.YoutubeDL(_download_opts(tmp, token)) as ydl:
            info_dict = ydl.extract_info(url, download=True)

        if info_dict.get("_type") == "playlist" and info_dict.get("entries"):
            info_dict = info_dict["entries"][0]

        files = os.listdir(tmp)
        if not files:
            raise HTTPException(status_code=500, detail="Файл не создан")

        # после постобработки ожидаем .m4a — ставим его первым
        files.sort(key=lambda f: 0 if f.lower().endswith(".m4a") else 1)
        fname = files[0]
        path = os.path.join(tmp, fname)
        ext = fname.rsplit(".", 1)[-1].lower()
        mime = EXT_MIME.get(ext, "application/octet-stream")

        return FileResponse(
            path,
            media_type=mime,
            headers=_meta_headers(info_dict),
            filename=fname,
            background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True),
        )
    except HTTPException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(tmp, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"Ошибка загрузки: {e}")


@app.get("/api/thumb")
def thumb(url: str = Query(..., min_length=4)):
    try:
        r = httpx.get(url, timeout=20, follow_redirects=True)
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Обложка недоступна: {e}")

    data = r.content
    mime = r.headers.get("content-type", "image/jpeg")

    # уменьшаем до 512px и пережимаем в JPEG, чтобы не раздувать телефон
    if Image is not None:
        try:
            img = Image.open(io.BytesIO(data)).convert("RGB")
            img.thumbnail((512, 512))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=82, optimize=True)
            data = buf.getvalue()
            mime = "image/jpeg"
        except Exception:  # noqa: BLE001
            pass  # если не вышло — отдаём оригинал

    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/healthz")
def healthz():
    return {"ok": True}


# ---------- SoundCloud «как клиент»: лайки, плейлисты, поиск ----------
# Токен — cookie `oauth_token` залогиненного soundcloud.com. Сервер его НЕ хранит: приложение
# держит его на телефоне и шлёт заголовком X-SC-Token с каждым запросом.
SC_API = "https://api-v2.soundcloud.com"
_SC_CID: dict = {"id": None}
_SC_HEADERS = {
    **BASE_OPTS["http_headers"],
    "Referer": "https://soundcloud.com/",
    "Origin": "https://soundcloud.com",
}


def _sc_client_id(force: bool = False) -> str:
    if _SC_CID["id"] and not force:
        return _SC_CID["id"]
    html = httpx.get("https://soundcloud.com/", headers=_SC_HEADERS, timeout=20, follow_redirects=True).text
    scripts = [
        m.group(1)
        for m in re.finditer(r'<script[^>]+src="([^"]+)"', html)
        if "sndcdn.com/assets" in m.group(1)
    ]
    for src in reversed(scripts):
        js = httpx.get(src, headers=_SC_HEADERS, timeout=20).text
        m = re.search(r'client_id:"([a-zA-Z0-9]{20,})"', js) or re.search(r"client_id=([a-zA-Z0-9]{20,})", js)
        if m:
            _SC_CID["id"] = m.group(1)
            return m.group(1)
    raise HTTPException(status_code=502, detail="SoundCloud client_id не найден")


def _sc_get(path: str, token: str | None = None, **params):
    headers = dict(_SC_HEADERS)
    if token:
        headers["Authorization"] = f"OAuth {token}"
    r = None
    for attempt in (0, 1):
        q = {**params, "client_id": _sc_client_id(force=bool(attempt))}
        r = httpx.get(f"{SC_API}{path}", params=q, headers=headers, timeout=25)
        if r.status_code == 401 and attempt == 0:
            continue  # возможно, протух client_id — обновим и повторим
        break
    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="SoundCloud не принял токен — обнови его в настройках")
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="Не найдено")
    if not r.is_success:
        raise HTTPException(status_code=502, detail=f"SoundCloud API {r.status_code}")
    return r.json()


def _sc_track_brief(t: dict) -> dict:
    ts = (t.get("media") or {}).get("transcodings") or []
    plain = any(
        (x.get("format") or {}).get("protocol") == "progressive"
        or ((x.get("format") or {}).get("protocol") == "hls" and "mpeg" in ((x.get("format") or {}).get("mime_type") or ""))
        for x in ts
    )
    art = t.get("artwork_url") or (t.get("user") or {}).get("avatar_url") or ""
    return {
        "id": t.get("id"),
        "title": t.get("title"),
        "uploader": (t.get("user") or {}).get("username"),
        "duration": round((t.get("duration") or 0) / 1000),
        "thumbnail": art.replace("-large.", "-t500x500.") if art else "",
        "url": t.get("permalink_url"),
        "drm": (not plain) if ts else False,  # только зашифрованные потоки = скачать нельзя
    }


def _need_token(token: str | None):
    if not token:
        raise HTTPException(status_code=401, detail="Нужен вход в SoundCloud — добавь токен в настройках")


@app.get("/api/sc/me")
def sc_me(token: str | None = Header(None, alias="X-SC-Token")):
    _need_token(token)
    me = _sc_get("/me", token)
    return {
        "id": me.get("id"),
        "username": me.get("username"),
        "avatar": (me.get("avatar_url") or "").replace("-large.", "-t200x200."),
    }


@app.get("/api/sc/likes")
def sc_likes(
    offset: int = 0,
    limit: int = 30,
    token: str | None = Header(None, alias="X-SC-Token"),
):
    _need_token(token)
    me = _sc_get("/me", token)
    data = _sc_get(f"/users/{me['id']}/track_likes", token, limit=limit, offset=offset, linked_partitioning=1)
    items = [_sc_track_brief(x["track"]) for x in data.get("collection", []) if x.get("track")]
    return {"items": items, "next_offset": (offset + limit) if data.get("next_href") else None}


@app.get("/api/sc/playlists")
def sc_playlists(token: str | None = Header(None, alias="X-SC-Token")):
    _need_token(token)
    me = _sc_get("/me", token)
    data = _sc_get(f"/users/{me['id']}/playlists", token, limit=50, linked_partitioning=1)
    out = []
    for p in data.get("collection", []):
        art = p.get("artwork_url") or ""
        out.append({
            "id": p.get("id"),
            "title": p.get("title"),
            "track_count": p.get("track_count"),
            "thumbnail": art.replace("-large.", "-t500x500.") if art else "",
        })
    return {"items": out}


@app.get("/api/sc/playlist")
def sc_playlist(id: int, token: str | None = Header(None, alias="X-SC-Token")):
    pl = _sc_get(f"/playlists/{id}", token)
    tracks = pl.get("tracks") or []
    full = [t for t in tracks if t.get("title")]
    thin = [t["id"] for t in tracks if not t.get("title")]
    for i in range(0, len(thin), 50):  # «тонкие» записи догружаем пачками
        got = _sc_get("/tracks", token, ids=",".join(map(str, thin[i:i + 50])))
        full.extend(got if isinstance(got, list) else [])
    order = {t.get("id"): i for i, t in enumerate(tracks)}
    full.sort(key=lambda t: order.get(t.get("id"), 10**9))
    return {"title": pl.get("title"), "items": [_sc_track_brief(t) for t in full]}


@app.get("/api/sc/search")
def sc_search(
    q: str = Query(..., min_length=1),
    limit: int = 25,
    token: str | None = Header(None, alias="X-SC-Token"),
):
    data = _sc_get("/search/tracks", token, q=q, limit=limit)
    return {"items": [_sc_track_brief(t) for t in data.get("collection", [])]}


# ---------- Фоновые задания (для сервера за прокси с таймаутами, напр. HF Spaces) ----------
# Долгий /api/download за прокси обрывается («Load failed» в Safari): байты не идут, пока
# yt-dlp качает и ffmpeg конвертирует. Здесь скачивание идёт в фоне, клиент опрашивает статус:
#   /api/start?url=  -> {"id"}        /api/status?id= -> state/progress        /api/file?id= -> файл
JOBS: dict = {}
JOBS_LOCK = threading.Lock()
JOB_TTL = 3600  # сек; незабранные задания и их файлы чистим


def _purge_jobs():
    now = time.time()
    with JOBS_LOCK:
        stale = [j for j, v in JOBS.items() if now - v["created"] > JOB_TTL]
        for jid in stale:
            shutil.rmtree(JOBS[jid].get("tmp") or "", ignore_errors=True)
            JOBS.pop(jid, None)


def _progress_hook(job: dict, d: dict):
    st = d.get("status")
    if st == "downloading":
        total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
        done = d.get("downloaded_bytes") or 0
        job["state"] = "downloading"
        job["progress"] = int(done * 100 / total) if total else None
    elif st == "finished":
        job["state"] = "converting"
        job["progress"] = 100


def _run_job(jid: str, url: str, token: str | None = None):
    job = JOBS[jid]
    tmp = tempfile.mkdtemp(prefix="volna_")
    job["tmp"] = tmp
    try:
        opts = _download_opts(tmp, token)
        opts["progress_hooks"] = [lambda d: _progress_hook(job, d)]
        with yt_dlp.YoutubeDL(opts) as ydl:
            info_dict = ydl.extract_info(url, download=True)
        if info_dict.get("_type") == "playlist" and info_dict.get("entries"):
            info_dict = info_dict["entries"][0]
        files = os.listdir(tmp)
        if not files:
            raise RuntimeError("Файл не создан")
        files.sort(key=lambda f: 0 if f.lower().endswith(".m4a") else 1)
        fname = files[0]
        job.update(
            state="done",
            progress=100,
            path=os.path.join(tmp, fname),
            fname=fname,
            mime=EXT_MIME.get(fname.rsplit(".", 1)[-1].lower(), "application/octet-stream"),
            info=info_dict,
            title=info_dict.get("title"),
        )
    except Exception as e:  # noqa: BLE001
        job.update(state="error", error=str(e))
        shutil.rmtree(tmp, ignore_errors=True)


@app.get("/api/start")
def job_start(
    url: str = Query(..., min_length=4),
    token: str | None = Header(None, alias="X-SC-Token"),
):
    _purge_jobs()
    jid = uuid.uuid4().hex
    JOBS[jid] = {"state": "queued", "progress": 0, "created": time.time(), "url": url}
    threading.Thread(target=_run_job, args=(jid, url, token), daemon=True).start()
    return {"id": jid}


@app.get("/api/status")
def job_status(id: str = Query(..., min_length=8)):
    job = JOBS.get(id)
    if not job:
        raise HTTPException(status_code=404, detail="Задание не найдено")
    return {
        "state": job["state"],
        "progress": job.get("progress"),
        "error": job.get("error"),
        "title": job.get("title"),
    }


@app.get("/api/file")
def job_file(id: str = Query(..., min_length=8)):
    job = JOBS.get(id)
    if not job:
        raise HTTPException(status_code=404, detail="Задание не найдено")
    if job["state"] != "done":
        raise HTTPException(status_code=409, detail="Ещё не готово")

    def _cleanup():
        shutil.rmtree(job.get("tmp") or "", ignore_errors=True)
        JOBS.pop(id, None)

    return FileResponse(
        job["path"],
        media_type=job["mime"],
        headers=_meta_headers(job["info"]),
        filename=job["fname"],
        background=BackgroundTask(_cleanup),
    )


# PWA — всё остальное отдаём как статику (index.html при заходе на /).
# На HF (app.py) монтируем позже, чтобы catch-all "/" не перекрыл Gradio.
def mount_static():
    app.mount("/", StaticFiles(directory="static", html=True), name="static")


if os.environ.get("VOLNA_DEFER_STATIC") != "1":
    mount_static()
