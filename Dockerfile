# ── Stage 1: Build React frontend ─────────────────────────────────────────────
FROM node:20-alpine AS frontend-build
# Cache buster: force rebuild on every commit
ARG BUILD_ID=default
RUN echo "Building with ID: $BUILD_ID"
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
# Build without exposing secrets as ARG/ENV (use runtime variables instead)
RUN npm run build

# ── Stage 2: Python backend + serve frontend ───────────────────────────────────
FROM python:3.12-slim
# Cache buster: force rebuild on every commit
ARG BUILD_ID=default
RUN echo "Backend build ID: $BUILD_ID"
WORKDIR /app/backend

# System deps
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

# Python deps
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ .

# Copy built frontend
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

# Non-root user for the runtime process. `app` owns /app and /data so
# uvicorn can read the code and write to the SQLite volume (Railway
# mounts /data). The gcc build dep from earlier is no longer needed for
# runtime and stays under root's ownership — that's fine because the
# app user only needs to execute python.
RUN groupadd --system --gid 1000 app \
  && useradd  --system --uid 1000 --gid app --home-dir /app --no-create-home app \
  && mkdir -p /data \
  && chown -R app:app /app /data

USER app

# Phase 2 scheduling redesign: turn the append-only schedule_events log ON in the
# deployed image. The flush listener defaults OFF in code, so local/dev/tests stay
# dark; only the shipped container captures. Kill-switch without a redeploy by
# setting SCHEDULE_EVENT_LOG_ENABLED=0 in Railway. See docs/scheduling-sync-redesign.md.
ENV SCHEDULE_EVENT_LOG_ENABLED=1

EXPOSE 8000
# --workers ${UVICORN_WORKERS:-4}: one uvicorn worker was blocking ALL traffic
# whenever a request tied it up (a slow /api/jobs, a hung Twilio call, the
# long-running request). Every other request queued past
# Railway's edge timeout → intermittent 502 "Application failed to respond."
# Memory headroom is huge (~300 MB per worker × 4 = ~1.2 GB well under the
# Railway instance). Override via UVICORN_WORKERS env var if we ever need to
# scale down (dev / staging).
#
# --proxy-headers --forwarded-allow-ips="*": without this, every request behind
# Railway's edge proxy shows up as the SAME client IP (the proxy's), so
# ratelimit.py's per-IP limiter (login, /api/intake/submit, /api/booking/submit)
# was actually a GLOBAL cap — one busy day or one bot could 429 real website
# leads for everyone. "*" rather than a CIDR because Railway's proxy address is
# not fixed and Railway does not publish a range.
#
# What "*" costs: it sets always_trust in uvicorn's ProxyHeadersMiddleware, and
# request.client.host then becomes the LEFTMOST X-Forwarded-For entry, which the
# caller writes. So it must never be the rate-limit key — ratelimit.client_ip()
# charges the LAST entry, the one Railway appended (#770). Anything else that
# reaches for a client address here needs the same treatment.
#
# export UVICORN_WORKERS: the app divides every rate-limit cap by the worker
# count, because the counters live in one process (ratelimit.WORKERS). Exporting
# the resolved value means uvicorn and the app read one number instead of the
# app guessing at the shell default.
CMD ["sh", "-c", "export UVICORN_WORKERS=${UVICORN_WORKERS:-4}; uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --workers $UVICORN_WORKERS --proxy-headers --forwarded-allow-ips=\"*\""]
