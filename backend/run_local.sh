#!/bin/bash
# Sobe a API sozinha (sem Celery/Redis) contra SQLite, pra testar/navegar
# rápido sem precisar de Docker. Onboarding automático fica desativado
# (ver comentário em app/api/competitors.py); use docker-compose.yml pra
# rodar a stack completa.
set -e
cd "$(dirname "$0")"
exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
