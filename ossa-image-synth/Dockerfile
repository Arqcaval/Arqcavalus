# Base images can be pulled through a mirror if Docker Hub rate-limits you:
#   docker build --build-arg REGISTRY=mirror.gcr.io/library/ .
ARG REGISTRY=

# ---- frontend build ----
FROM ${REGISTRY}node:22-bookworm-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- runtime ----
FROM ${REGISTRY}python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    IMAGE_SYNTH_DATA_DIR=/data STATIC_DIR=/app/static
WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY --from=web /web/dist ./static
# uid 1000 so the image also runs on hosts that force that user (e.g. Hugging Face Spaces)
RUN useradd --uid 1000 --create-home synth && mkdir -p /data && chown synth /data
USER synth
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
