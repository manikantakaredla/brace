FROM python:3.12-slim
WORKDIR /workspace
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY . ./brace
ENV PYTHONPATH=/workspace BRACE_DB=/data/brace.sqlite3 PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn","brace.api.main:app","--host","0.0.0.0","--port","8000"]
