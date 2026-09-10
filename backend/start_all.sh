#!/bin/bash
# "wait -n" é bashismo (dash não suporta) — por isso o shebang é bash, não sh.
# Roda API + workers + beat no mesmo container/serviço, pra não precisar de
# serviços separados no Railway pra um uso de baixo volume. Se qualquer um
# cair, o script inteiro sai (e o Railway reinicia o container) — não fica
# um processo morto rodando escondido atrás dos outros vivos.
set -e

uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" &
API_PID=$!

# Worker "geral": cadastro, snapshot, raio-x — tudo HTTP/DB, leve, sem
# Chromium. Concorrência alta é seguro aqui.
celery -A app.tasks.celery_app worker --loglevel=info --concurrency=4 -Q celery -n general@%h &
WORKER_PID=$!

# Worker "browser_heavy" separado: ads_monitor e ad_miner abrem um Chromium
# via Playwright por chamada (scrapers/browser.py). Era concurrency=1 (no
# máximo 1 navegador headless rodando por vez no container inteiro) —
# decisão de quando o app tinha ~45 concorrentes no total; sem isso,
# cadastrar 2-3 lojas seguidas (cada uma dispara um scan de anúncios) já
# derrubava até leituras simples do dashboard por 30s+, porque o worker
# geral e a API competiam pela mesma CPU com N Chromiums abertos ao mesmo
# tempo (ver task_routes em app/tasks/celery_app.py).
#
# Subido pra 3 (não mais que isso de uma vez) — preparando pra ~50 usuários,
# onde 1 scan por vez levaria fácil mais de 1 dia pra passar por todo mundo
# (a rotina roda 1x/dia, ads-monitor-daily-8am). Verificado antes de mudar:
# CPU do serviço estava em <0.01 vCPU de uso (contra teto de 8 vCPU/8GB —
# ver `railway metrics`), sobra de verdade pra rodar mais de um Chromium ao
# mesmo tempo sem repetir o problema de antes. Se voltar a travar o
# dashboard sob carga real, é sinal de separar esse worker num serviço
# Railway À PARTE (não dividir CPU com a API/worker geral) em vez de só
# baixar esse número de novo.
celery -A app.tasks.celery_app worker --loglevel=info --concurrency=3 -Q browser_heavy -n browser@%h &
BROWSER_WORKER_PID=$!

celery -A app.tasks.celery_app beat --loglevel=info &
BEAT_PID=$!

trap 'kill $API_PID $WORKER_PID $BROWSER_WORKER_PID $BEAT_PID 2>/dev/null' TERM INT

wait -n $API_PID $WORKER_PID $BROWSER_WORKER_PID $BEAT_PID
EXIT_CODE=$?
kill $API_PID $WORKER_PID $BROWSER_WORKER_PID $BEAT_PID 2>/dev/null
exit $EXIT_CODE
