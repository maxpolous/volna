FROM python:3.12-slim

# ffmpeg нужен yt-dlp для извлечения/конвертации аудио в m4a (iOS-совместимо)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render/Fly задают $PORT сами; HF Spaces по умолчанию 7860; локально 8000
ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT}"]
