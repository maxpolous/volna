"""
Точка входа для Hugging Face Space (SDK: gradio, ZeroGPU).

Раннер HF/ZeroGPU ждёт штатный блокирующий demo.launch(). Поэтому сервером владеет Gradio,
а наш API (/api/*, /healthz) и PWA (/app/) мы добавляем в его FastAPI через хук
App.create_app — маршруты вставляются в начало, чтобы срабатывать раньше Gradio.
"""

import os
import traceback

# ZeroGPU-раннер HF требует, чтобы процесс зарегистрировался через пакет `spaces`
# (импорт должен идти раньше gradio/torch). GPU нам не нужен, но без импорта
# раннер считает Space неинициализированным и ставит RUNTIME_ERROR.
try:
    import spaces
    print("[volna] spaces imported", flush=True)
except Exception as _e:  # noqa: BLE001
    spaces = None
    print(f"[volna] spaces not imported: {_e}", flush=True)

os.environ.setdefault("VOLNA_DEFER_STATIC", "1")  # server.py не монтирует "/" сам
# HF сам ставит GRADIO_SSR_MODE=true; SSR поднимает Node-прокси на 7860, который падает.
os.environ["GRADIO_SSR_MODE"] = "false"

import gradio as gr  # noqa: E402
import gradio.routes as gr_routes  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from starlette.routing import Mount  # noqa: E402

import server  # noqa: E402  (наш FastAPI с /api/* и /healthz)

print(f"[volna] gradio={gr.__version__}", flush=True)


def _attach(app_):
    for r in list(server.app.router.routes):
        p = getattr(r, "path", "")
        if p.startswith("/api") or p == "/healthz":
            app_.router.routes.insert(0, r)
    app_.router.routes.insert(
        0, Mount("/app", app=StaticFiles(directory="static", html=True), name="pwa")
    )
    print("[volna] routes attached: /api/*, /healthz, /app/", flush=True)


_orig_create_app = gr_routes.App.create_app


def _patched_create_app(*args, **kwargs):
    app_ = _orig_create_app(*args, **kwargs)
    try:
        _attach(app_)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
    return app_


gr_routes.App.create_app = _patched_create_app

# ZeroGPU требует хотя бы одну функцию с @spaces.GPU, привязанную к событию Gradio
# ("No @spaces.GPU function detected during startup"). GPU нам не нужен: функция
# висит на скрытой кнопке и никогда не вызывается, GPU не выделяется.
_gpu = spaces.GPU(duration=1) if spaces is not None else (lambda f: f)


@_gpu
def _noop(x):
    return x


with gr.Blocks(title="Волна") as demo:
    gr.Markdown(
        "## 🌊 Волна\n"
        "Это служебная страница сервера. Само приложение здесь: **[/app/](/app/)** — "
        "открой в Safari и добавь на экран «Домой»."
    )
    _hidden_in = gr.Textbox(visible=False)
    _hidden_btn = gr.Button("noop", visible=False)
    _hidden_btn.click(_noop, _hidden_in, _hidden_in)


if __name__ == "__main__":
    demo.launch(ssr_mode=False)  # блокирующий штатный запуск — так ждёт раннер HF
