FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    PULSE_DATABASE=/app/data/pulse.sqlite3

WORKDIR /app
COPY index.html style.css script.js server.py ./
RUN mkdir -p /app/data && chown -R nobody:nogroup /app
USER nobody

EXPOSE 8000
CMD ["python", "server.py"]
