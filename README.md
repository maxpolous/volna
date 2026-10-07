---
title: Volna
emoji: 🌊
colorFrom: red
colorTo: indigo
sdk: gradio
sdk_version: 6.29.1
app_file: app.py
pinned: false
---

# Волна 🌊

Личный музыкальный клиент для iPhone (и любого браузера), который ставится на экран «Домой» как
приложение. Ищешь или открываешь свои лайки/плейлисты SoundCloud, тапаешь трек — он **скачивается
на телефон** и играет офлайн. Никаких аккаунтов разработчика, App Store и платных сервисов.

- Библиотека хранится **на устройстве** (IndexedDB): играет без сети, управление с экрана
  блокировки, обложки, кнопка «Сохранить в Файлы» (открывает системное меню — выбираешь папку
  или приложение сам).
- Вход в SoundCloud — **своей сессией** (токен хранится только на телефоне, сервер его не
  сохраняет). Открываются «Лайки», «Плейлисты», «Поиск».
- Можно добавить трек просто ссылкой (SoundCloud, в yt-dlp-версии — ещё и YouTube).

> Качай только то, что имеешь право слушать офлайн. Скачивание может нарушать условия
> площадок — ответственность на пользователе.

## Что не умеет (честно)

- **DRM-треки SoundCloud** (отдаются только зашифрованным HLS) — не скачиваются нигде, обход DRM
  не делается. В списках такие помечены замком 🔒.
- **YouTube** работает только в yt-dlp-версии и только с «домашнего» IP или с cookies: с IP
  облачных хостингов YouTube требует вход («Sign in to confirm you're not a bot»).
- Форма «логин/пароль» для SoundCloud невозможна: у SoundCloud нет публичного API входа для
  сторонних приложений (регистрация приложений — платная, Artist Pro).

## Две версии бэкенда

| | **Cloudflare Worker** (`src/index.js`) | **Python / yt-dlp** (`server.py`) |
|---|---|---|
| Хостинг | Cloudflare Workers, бесплатно, не спит | Hugging Face Space (бесплатно, Gradio+ZeroGPU), Docker, любой сервер |
| SoundCloud | ✅ (без DRM) | ✅ (без DRM) |
| YouTube | ❌ | ✅ с домашнего IP; в облаке — с cookies (секрет `YT_COOKIES`) |
| Скачивание | прямой поток (MP3) | фоновые задания с прогрессом, ffmpeg → m4a |

Фронтенд (`static/`) один и тот же — он сам определяет, какой бэкенд перед ним.

## Как пользоваться (iPhone)

1. Открой адрес своего развёрнутого бэкенда в **Safari** (для HF-версии — с `/app/` на конце).
2. «Поделиться» → **«На экран „Домой“»**. Запускай с иконки.
3. **Войти в SoundCloud** (один раз): шестерёнка → вставить токен → «Сохранить и проверить».
   Токен — это cookie `oauth_token` залогиненного soundcloud.com:
   - с компьютера: DevTools → Application/Storage → Cookies → soundcloud.com → `oauth_token`;
   - с телефона: шестерёнка → «Вход в один тап» → скопировать код закладки → создать в Safari
     закладку с этим кодом → на открытом soundcloud.com тапнуть закладку.
4. Вкладки **Лайки / Плейлисты / Поиск**: тап по треку — скачать. ✓ — уже в библиотеке, 🔒 — DRM.
5. **Библиотека**: тап — играть; иконка «поделиться» — сохранить в Файлы/другое приложение.

Токен даёт доступ к твоему аккаунту — никому не показывай. Живёт месяцами; протух — повтори шаг 3.

## Развернуть себе

### Вариант A — Cloudflare Workers (проще всего, бесплатно, без карты)

1. Форкни репозиторий.
2. Cloudflare Dashboard → **Workers & Pages → Create → Import a repository** → выбери форк.
   Worker собирается из `wrangler.toml` (статика из `static/`, код из `src/index.js`), ничего
   настраивать не нужно. Каждый push в ветку — авторедеплой.
3. Готово: `https://<имя>.<аккаунт>.workers.dev`. Открой в Safari → «На экран „Домой“».

Локально: `npm i -D wrangler && npx wrangler dev` (нужен Node 18+).

### Вариант B — Hugging Face Space (бесплатно, с YouTube через cookies)

Docker-Spaces на HF платные, поэтому используется **Gradio SDK + ZeroGPU** (бесплатно):
`app.py` поднимает Gradio, а наш FastAPI и PWA подвешиваются к нему (`/api/*`, `/app/`).

1. Создай Space: **SDK = Gradio**, hardware = **ZeroGPU**. Метаданные берутся из шапки этого README.
2. Залей файлы репозитория в Space (git push в `main` или через веб-интерфейс).
3. (Опционально, для YouTube) Settings → **Secrets** → `YT_COOKIES` = содержимое `cookies.txt`
   (Netscape-формат, экспорт из браузера с запасного аккаунта).
4. Приложение по адресу `https://<user>-<space>.hf.space/app/`.

Грабли ZeroGPU, которые уже учтены в `app.py`: обязателен `import spaces` и хотя бы одна функция
с `@spaces.GPU` (иначе `No @spaces.GPU function detected`), SSR Gradio надо выключать
(`GRADIO_SSR_MODE=false`, иначе Node-прокси занимает порт), корень должен отдавать Gradio.
Space засыпает после 48 ч простоя и просыпается ~30–60 с на первом запросе.

### Вариант C — Docker / свой сервер (полный yt-dlp, лучше всего для YouTube)

```bash
docker build -t volna .
docker run -p 7860:7860 volna
# или без Docker (нужен ffmpeg):
pip install -r requirements.txt && uvicorn server:app --host 0.0.0.0 --port 7860
```

Приложение по адресу сервера (корень). Для доступа с телефона из любого места — Cloudflare
Tunnel (`cloudflared tunnel --url http://localhost:7860`) или свой домен с HTTPS: PWA требует
HTTPS. Cookies для YouTube: файл `cookies.txt` рядом с `server.py` или переменная `COOKIES_FILE`.

## Структура

```
static/            PWA: index.html, app.js (библиотека, плеер, клиент SoundCloud), sw.js, иконки
src/index.js       Cloudflare Worker: раздача статики + /api/* (SoundCloud на чистом JS)
server.py          FastAPI + yt-dlp: /api/info|download|start|status|file|thumb, /api/sc/*
app.py             обёртка для Hugging Face (Gradio + ZeroGPU)
wrangler.toml      конфиг Worker;  Dockerfile / requirements.txt / packages.txt — Python-версия
make_icons.py      генератор иконок
```

### API (одинаков для обеих версий)

- `GET /api/info?url=` · `GET /api/download?url=` · `GET /api/thumb?url=`
- yt-dlp-версия дополнительно: `GET /api/start?url=` → `GET /api/status?id=` → `GET /api/file?id=`
- Клиент SoundCloud (заголовок `X-SC-Token: <oauth_token>`): `GET /api/sc/me`,
  `/api/sc/likes?offset=`, `/api/sc/playlists`, `/api/sc/playlist?id=`, `/api/sc/search?q=`

Секреты в репозитории не хранятся: токены — только на устройстве пользователя, cookies — в
секретах хостинга (`cookies.txt` в `.gitignore`).

## Лицензия

MIT — см. `LICENSE`.
