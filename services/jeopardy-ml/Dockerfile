FROM python:3.12-slim

# LightGBM requires libgomp1 on Linux containers
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/

RUN useradd --create-home --shell /bin/bash mluser \
    && mkdir -p /app/models \
    && chown -R mluser:mluser /app

USER mluser

ENV PYTHONUNBUFFERED=1 \
    CLICKHOUSE_HTTP_URL=http://clickhouse:8123 \
    CLICKHOUSE_USER=jeopardy \
    CLICKHOUSE_PASSWORD=jeopardy \
    MODEL_OUTPUT_DIR=/app/models

# Default Kubernetes CronJob command: train + export ONNX + generate Tier-2 SLA calibration proposal
CMD ["sh", "-c", "python -m src.train_and_export --output-dir ${MODEL_OUTPUT_DIR} && python -m src.calibrate_slas --output ${MODEL_OUTPUT_DIR}/calibration_proposal.json"]
