# ── Stage 1: Build React frontend ─────────────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
# Accept API key from Railway env vars (BRIGHTBASE_API_KEY) or explicit VITE_API_KEY
ARG VITE_API_KEY
ARG BRIGHTBASE_API_KEY
ENV VITE_API_KEY=${VITE_API_KEY:-$BRIGHTBASE_API_KEY}
RUN npm run build

# ── Stage 2: Python backend + serve frontend ───────────────────────────────────
FROM python:3.12-slim
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

# Data directory for SQLite persistence (mount a Railway volume here)
RUN mkdir -p /data

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
