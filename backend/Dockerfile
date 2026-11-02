# syntax=docker/dockerfile:1
#
# ResQ AI backend (FastAPI) - production image.
#
#   docker build -t resq-ai-backend ./backend
#   docker run --rm -p 8000:8000 --env-file .env -v resq-data:/app/data resq-ai-backend
#
# Two stages: dependencies are installed into a virtualenv in a throw-away builder stage,
# then only that virtualenv and the application code are copied into a clean runtime image
# that runs as an unprivileged user. The SQLite database lives in the /app/data volume.

ARG PYTHON_VERSION=3.13

# --------------------------------------------------------------------------------------------
# builder: resolve and install the pinned runtime dependencies
# --------------------------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# Only requirements.txt is copied first so this layer stays cached until the pins change.
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# --------------------------------------------------------------------------------------------
# runtime: minimal image, non-root user, read-only code, writable data volume
# --------------------------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS runtime

ARG APP_UID=10001
ARG APP_GID=10001

LABEL org.opencontainers.image.title="resq-ai-backend" \
      org.opencontainers.image.description="ResQ AI disaster-response API (FastAPI)" \
      org.opencontainers.image.source="https://github.com/Mayank-thakur21/resq-ai" \
      org.opencontainers.image.licenses="MIT"

# APP_ENV and DATABASE_URL are safe container defaults; everything else (API keys, shared
# secrets) is injected at runtime with --env-file / docker compose and never baked in.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}" \
    APP_ENV=production \
    DATABASE_URL=sqlite+aiosqlite:////app/data/resq.db

RUN groupadd --system --gid "${APP_GID}" resq \
    && useradd --system --uid "${APP_UID}" --gid resq --home-dir /app --no-create-home \
       --shell /usr/sbin/nologin resq

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv

# The code stays owned by root (the service cannot modify itself); only /app/data is
# writable by the service user. Named volumes mounted there inherit this ownership.
COPY app ./app
RUN mkdir -p /app/data && chown resq:resq /app/data
VOLUME ["/app/data"]

USER resq

EXPOSE 8000

# /api/health returns 503 (HTTPError -> exit 1) when the database is unavailable. The empty
# ProxyHandler ignores any HTTP(S)_PROXY injected into the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request as u; u.build_opener(u.ProxyHandler({})).open('http://127.0.0.1:8000/api/health', timeout=4)"]

# A single worker on purpose: SQLite, the in-process rate limiter and the alert poller all
# assume one process. --proxy-headers honours X-Forwarded-Proto/For from trusted proxies
# (FORWARDED_ALLOW_IPS, default 127.0.0.1).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
