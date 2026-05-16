FROM node:24-slim

WORKDIR /app

# System deps: Python 3 + pip for the Databento sidecar, supervisord to run
# Node and Python together inside one Fly machine. ca-certificates is needed
# for the Databento SDK's TLS handshake to the upstream gateway.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      supervisor \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Node deps first (cache layer).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Python deps — installed into a venv so the system pip stays untouched
# (PEP 668 / Debian's externally-managed-environment guard).
ENV VIRTUAL_ENV=/opt/databento-venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
COPY python/requirements.txt ./python/requirements.txt
RUN pip install --no-cache-dir -r python/requirements.txt

COPY src ./src
COPY data ./data
COPY python ./python
COPY scripts ./scripts
COPY python/supervisord.conf /etc/supervisor/conf.d/pmp-ingestion.conf

ENV NODE_ENV=production
ENV PORT=8080
ENV DATABENTO_SIDECAR_HOST=127.0.0.1
ENV DATABENTO_SIDECAR_PORT=9090

EXPOSE 8080

CMD ["supervisord", "-c", "/etc/supervisor/conf.d/pmp-ingestion.conf"]
