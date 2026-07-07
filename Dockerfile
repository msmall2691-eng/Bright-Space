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

EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
