"""Celery app + agendamento (Celery Beat) — jobs diários automáticos."""

from celery import Celery
from celery.schedules import crontab

from app.config import get_settings

settings = get_settings()

celery_app = Celery(
    "competitor_intel",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "app.tasks.onboarding",
        "app.tasks.daily_snapshot",
        "app.tasks.weekly_xray",
        "app.tasks.ads_monitor",
        "app.tasks.ad_miner",
        "app.tasks.retention",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="America/Bogota",
    enable_utc=True,
    task_track_started=True,
    # Ver comentário em app/config.py — só ligado no atalho local sem Docker.
    task_always_eager=settings.celery_task_always_eager,
    task_eager_propagates=settings.celery_task_always_eager,
    # ads_monitor e ad_miner abrem um Chromium via Playwright por chamada
    # (scrapers/browser.py) — pesado de CPU/memória. Web + worker rodam no
    # MESMO container (start_all.sh), então com --concurrency=4 no worker
    # geral, 2-3 cadastros de loja em sequência (cada um dispara um scan de
    # anúncios em background) já bastavam pra travar até um GET simples do
    # dashboard por 5-30s — reproduzido ao vivo (POST de cadastro chegou a
    # 32s mesmo com o domínio nem existindo). Isolar essas tasks numa fila
    # própria, consumida por um worker separado com --concurrency=1
    # (start_all.sh), garante no máximo 1 Chromium rodando por vez, sem
    # afetar a fila padrão (cadastro, snapshot, raio-x) que é só HTTP/DB.
    task_routes={
        "app.tasks.ads_monitor.*": {"queue": "browser_heavy"},
        "app.tasks.ad_miner.*": {"queue": "browser_heavy"},
    },
)

celery_app.conf.beat_schedule = {
    # Era só 6h (1x/dia) — trocado pra a cada 4h depois de um caso real: um
    # concorrente subiu o preço de 144 pra 154 pra 164 e voltou pra 154 tudo
    # dentro do mesmo dia (tática de ancoragem/urgência), e como a captura só
    # comparava "ontem vs hoje", a ida-e-volta terminou batendo com o valor
    # anterior e nenhuma mudança foi detectada — não era bug de comparação,
    # era intervalo grande demais entre capturas pra pegar oscilação rápida.
    "snapshot-every-4h": {
        "task": "app.tasks.daily_snapshot.run_daily_snapshot_all",
        "schedule": crontab(hour="6,10,14,18,22", minute=0),
    },
    "weekly-xray-monday-7am": {
        "task": "app.tasks.weekly_xray.run_weekly_xray_all",
        "schedule": crontab(hour=7, minute=0, day_of_week=1),
    },
    "ads-monitor-daily-8am": {
        "task": "app.tasks.ads_monitor.run_ads_monitor_all",
        "schedule": crontab(hour=8, minute=0),
    },
    # Rede de segurança pro cadastro assíncrono — ver docstring de
    # reconcile_stuck_onboarding. Frequência alta de propósito: o objetivo é
    # destravar rápido um cadastro que nunca chegou a entrar na fila, não
    # substituir o fluxo normal (que já é rápido).
    "reconcile-stuck-onboarding-3min": {
        "task": "app.tasks.onboarding.reconcile_stuck_onboarding",
        "schedule": crontab(minute="*/3"),
    },
    # Achado ao vivo (2026-08-29): disco do Postgres em ~50% de um teto de
    # 5GB do Hobby com só 10 dias de app no ar — ver docstring de
    # app/tasks/retention.py. Roda de madrugada (3h), fora do horário dos
    # outros jobs pesados acima.
    "purge-old-history-daily-3am": {
        "task": "app.tasks.retention.purge_old_history",
        "schedule": crontab(hour=3, minute=0),
    },
}
