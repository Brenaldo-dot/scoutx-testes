"""Módulo 1 — gerenciamento de concorrentes."""

import logging
import secrets
import threading
import time

from contextlib import contextmanager

import redis
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, selectinload

from app.api.deps import CurrentUser, get_current_user, resolve_target_user
from app.config import get_settings
from app.database import get_db
from app.models import Alert, Competitor, CompetitorStatus, CompetitorTracker, Product, ProtectedStore
from app.schemas.competitor import (
    CompetitorCreate,
    CompetitorDetailOut,
    CompetitorOut,
    CompetitorUpdate,
    ProtectedStoreCreate,
    ProtectedStoreOut,
)
from app.services.competitor_service import normalize_domain, register_competitor
from app.tasks.ads_monitor import run_ads_monitor_one
from app.tasks.daily_snapshot import run_daily_snapshot_one
from app.tasks.onboarding import run_onboarding_xray
from app.tasks.celery_app import celery_app
from app.tasks.retention import run_purge

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/competitors", tags=["competitors"])


def _enqueue(task, *args, label: str) -> None:
    # send_task/.delay() é uma chamada SÍNCRONA e bloqueante (kombu/redis-py
    # puro, não asyncio). Visto ao vivo: chamada direto dentro de um `async
    # def` do FastAPI, ela trava 20-30s pra publicar no Redis (mesmo com
    # Postgres, CPU e o Redis em si saudáveis — confirmado via
    # /api/_debug/pg_activity rodando em paralelo sem nenhum lock, e via
    # `railway metrics` com CPU/memória ociosas o tempo todo); o MESMO worker
    # Celery conecta no mesmo Redis instantaneamente no próprio startup. Não
    # foi possível confirmar a causa exata (provável fricção entre o cliente
    # bloqueante do kombu e o event loop do uvicorn), então em vez de
    # persegui-la, tiramos essa chamada do caminho síncrono da resposta HTTP:
    # roda numa thread solta, sem o cliente esperar. Cadastro/rescan
    # continuam funcionando (a task só entra na fila alguns segundos depois),
    # só não trava mais quem está cadastrando a próxima loja.
    def _run():
        try:
            task.delay(*args)
        except Exception:
            logger.warning(
                "Não consegui enfileirar %s (fila/Redis indisponível?)",
                label,
            )

    threading.Thread(target=_run, daemon=True).start()


def _owned_query(db: Session, user_id: int):
    """Só os concorrentes que ESSE usuário rastreia (competitor_trackers) —
    o dado em si (Competitor) é compartilhado entre quem rastreia a mesma
    loja, mas a LISTA de cada um é só a dela. Admin usa isso igual todo
    mundo pra própria aba; ver outro usuário é sempre explícito (parâmetro
    `as_user_id` nos endpoints de leitura, nunca um bypass automático)."""
    return db.query(Competitor).join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id).filter(
        CompetitorTracker.user_id == user_id
    )


def _assert_operation_allowed(db: Session, current_user: CurrentUser, effective_operation: str) -> None:
    """Limite de países do plano (Módulo de planos/organizações) — só entra
    em ação pra quem tem organização com teto definido (org_max_operations
    vindo do Node via header, ver api/deps.py); conta admin e plano Enterprise
    não mandam esse header, ficam sem limite. `operation` é texto livre (o
    frontend deixa digitar qualquer país, ver OperationContext.jsx no React),
    então não dá pra validar contra uma lista fixa — conta os países
    DISTINTOS que já aparecem de verdade nos concorrentes rastreados por
    qualquer colega da mesma organização."""
    if current_user.org_max_operations is None or not current_user.org_member_ids:
        return
    used = {
        row[0]
        for row in db.query(Competitor.operation)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id.in_(current_user.org_member_ids))
        .distinct()
        .all()
    }
    if effective_operation in used:
        return
    if len(used) >= current_user.org_max_operations:
        raise HTTPException(
            400,
            f"Sua organização já está no limite de {current_user.org_max_operations} país(es) do plano, "
            "fale com um administrador pra liberar mais países.",
        )


def _assert_competitor_limit_allowed(
    db: Session, current_user: CurrentUser, existing_competitor_id: int | None
) -> None:
    """Limite de concorrentes cadastrados do plano (mesmo módulo do limite de
    países acima) — org_max_competitors vem do Node via header, ver
    api/deps.py; conta admin e plano Enterprise não mandam esse header, ficam
    sem limite. Reaproveitar um concorrente que a organização já rastreia
    (mesmo domínio, cadastrado por outro colega) não consome vaga nova — só
    um concorrente de verdade INÉDITO pra organização conta, mesmo raciocínio
    do "país já usado" acima."""
    if current_user.org_max_competitors is None or not current_user.org_member_ids:
        return
    owned_ids = {
        row[0]
        for row in db.query(Competitor.id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id.in_(current_user.org_member_ids))
        .distinct()
        .all()
    }
    if existing_competitor_id is not None and existing_competitor_id in owned_ids:
        return
    if len(owned_ids) >= current_user.org_max_competitors:
        raise HTTPException(
            400,
            f"Sua organização já está no limite de {current_user.org_max_competitors} concorrente(s) cadastrado(s) "
            "do plano, fale com um administrador pra liberar mais, ou remova um concorrente antes de cadastrar outro.",
        )


_LOCK_POLL_INTERVAL_S = 0.2
_LOCK_MAX_WAIT_S = 8.0
_LOCK_TTL_S = 30

_redis_client = redis.from_url(get_settings().redis_url, decode_responses=True)

_RELEASE_LOCK_SCRIPT = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""


@contextmanager
def _org_limit_lock(current_user: CurrentUser):
    """Achado em auditoria de segurança (2026-08-26): `_assert_competitor_limit_allowed`
    é ler-depois-escrever sem trava nenhuma — duas requisições concorrentes
    (2 abas, ou um script disparando rápido) podiam ler a MESMA contagem
    "1 vaga livre", as duas passarem na checagem, e a organização acabar com
    mais concorrentes do que o plano permite. A trava serializa só quem tenta
    mexer na MESMA organização (a chave é o menor id de membro da org —
    estável e único por org já que cada organização tem seu próprio conjunto
    de usuários) — outras organizações continuam cadastrando em paralelo sem
    ninguém esperar a vez de ninguém.

    Achado ao vivo (2026-08-27, derrubou o app inteiro pra TODO MUNDO, não só
    quem estava criando concorrente): a versão original usava
    `pg_advisory_lock` do Postgres, que BLOQUEIA indefinidamente se o dono
    anterior nunca soltar — e como o FastAPI roda handler síncrono numa
    threadpool de tamanho fixo, poucas requisições presas pra sempre já
    bastavam pra esgotar TODAS as threads, travando até pedido que nem
    passava perto dessa trava. Trocado então por `pg_try_advisory_lock` num
    loop com teto de espera.

    Achado ao vivo de novo (2026-08-28, org do Augusto travada pra sempre
    nesse mesmo erro): `pg_advisory_lock`/`pg_try_advisory_lock` são travas
    de SESSÃO do Postgres — presas à conexão física de verdade no servidor,
    não à transação. Esse serviço fala com o Postgres através do PgBouncer
    em modo "transaction pooling" (ver DATABASE_URL — aponta pro host
    `pgbouncer`, não direto pro Postgres): o PgBouncer pode trocar a conexão
    física por baixo dos panos a cada commit. Como `register_competitor` faz
    mais de um commit dentro do bloco protegido, dava (e vai sempre dar,
    inevitavelmente) pra pegar a trava numa conexão física e depois soltar
    numa OUTRA — o soltar vira um no-op silencioso, e a trava original fica
    presa pra sempre naquela conexão até o PgBouncer decidir reciclá-la,
    derrubando com um 503 QUALQUER pedido futuro dessa mesma organização.
    Trocado pra uma trava no Redis (SET NX com expiração de _LOCK_TTL_S
    segundos): sem afinidade de conexão nenhuma, e mesmo que o processo caia
    no meio do caminho sem soltar, a trava expira sozinha — nunca mais fica
    presa pra sempre."""
    if current_user.org_max_competitors is None or not current_user.org_member_ids:
        yield
        return
    lock_key = f"org-competitor-lock:{min(current_user.org_member_ids)}"
    token = secrets.token_hex(16)
    waited = 0.0
    while True:
        acquired = _redis_client.set(lock_key, token, nx=True, ex=_LOCK_TTL_S)
        if acquired:
            break
        if waited >= _LOCK_MAX_WAIT_S:
            raise HTTPException(
                503,
                "Muita gente mexendo na sua organização ao mesmo tempo, tenta de novo em alguns segundos.",
            )
        time.sleep(_LOCK_POLL_INTERVAL_S)
        waited += _LOCK_POLL_INTERVAL_S
    try:
        yield
    finally:
        _redis_client.eval(_RELEASE_LOCK_SCRIPT, 1, lock_key, token)


@router.post("", response_model=CompetitorOut, status_code=201)
async def create_competitor(
    payload: CompetitorCreate, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)
):
    domain = normalize_domain(payload.domain)
    existing_for_user = (
        _owned_query(db, current_user.id).filter(Competitor.domain == domain).first()
    )
    if existing_for_user and existing_for_user.operation != payload.operation:
        raise HTTPException(
            409,
            f'{domain} já está na sua lista na operação "{existing_for_user.operation}" (como '
            f'"{existing_for_user.name}"). Um domínio só pode pertencer a uma operação por vez, troque pra '
            "essa operação pra ver o cadastro, ou exclua-o antes de recadastrar em outra.",
        )
    # Achado pelo usuário: cadastrar de novo um domínio que ele mesmo já
    # rastreia (mesma operação) não dava erro nenhum nem mudava nada na tela
    # (register_competitor só reaproveita a linha, sem criar tracker
    # duplicado) — parecia que o clique "não fez nada". Agora avisa com
    # clareza em vez de ficar mudo.
    if existing_for_user:
        raise HTTPException(409, f'"{existing_for_user.name}" ({domain}) já está cadastrado na sua lista.')

    # Domínio já rastreado por outro usuário: register_competitor reaproveita
    # a linha e IGNORA o payload.operation, mantendo o país original — o
    # limite tem que ser checado contra esse país de verdade, não contra o
    # que o formulário mandou, senão adicionar uma loja que a própria
    # organização já rastreia consumiria uma vaga de país à toa.
    with _org_limit_lock(current_user):
        existing_competitor = db.query(Competitor).filter(Competitor.domain == domain).first()
        effective_operation = existing_competitor.operation if existing_competitor else payload.operation
        _assert_operation_allowed(db, current_user, effective_operation)
        _assert_competitor_limit_allowed(db, current_user, existing_competitor.id if existing_competitor else None)

        competitor, is_new_competitor, _is_new_tracker = await register_competitor(
            db, payload.domain, payload.name, payload.niche, payload.tags, current_user.id, payload.operation
        )
    # Só dispara o raio-x se o DOMÍNIO em si é inédito e a loja não é
    # protegida (register_competitor já cria protegida direto em
    # NOT_SHOPIFY, sem passar por CHECKING) — se outro usuário já rastreia
    # (dado reaproveitado, ver register_competitor), não faz sentido raspar
    # tudo de novo só porque mais alguém passou a rastrear também.
    if is_new_competitor and competitor.status == CompetitorStatus.CHECKING:
        _enqueue(run_onboarding_xray, competitor.id, label=f"o raio-x inicial de {competitor.domain}")
    return competitor


@router.get("", response_model=list[CompetitorOut])
def list_competitors(
    status: CompetitorStatus | None = None,
    operation: str | None = None,
    as_user_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    target_user = resolve_target_user(current_user, as_user_id)
    query = _owned_query(db, target_user)
    if status:
        query = query.filter(Competitor.status == status)
    if operation:
        query = query.filter(Competitor.operation == operation)
    competitors = query.order_by(Competitor.created_at.desc()).all()

    # "Desde quando essa loja está no mercado" (filtro "Lojas mais antigas" no
    # front) — não é uma coluna cacheada no Competitor, calcula na hora a
    # partir do produto ATIVO mais antigo de cada um (mesma data
    # shopify_created_at que EspionarLoja usa pra "criado há Xd", só que aqui
    # é o MENOR valor da loja inteira, não o de 1 produto). Uma query só pra
    # todos os concorrentes da página, não uma por card.
    if competitors:
        oldest_rows = (
            db.query(Product.competitor_id, func.min(Product.shopify_created_at))
            .filter(
                Product.competitor_id.in_([c.id for c in competitors]),
                Product.is_active.is_(True),
                Product.shopify_created_at.isnot(None),
            )
            .group_by(Product.competitor_id)
            .all()
        )
        oldest_by_competitor = dict(oldest_rows)
        for c in competitors:
            c.oldest_product_at = oldest_by_competitor.get(c.id)
    return competitors


@router.get("/my-operations-limit")
def my_operations_limit(db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)):
    """Pra qualquer usuário logado (não só admin) — o seletor de país e o
    formulário de cadastrar concorrente usam isso pra mostrar o que já cabe
    no plano da própria organização e o que está travado, ANTES de tentar
    cadastrar (mesma conta usada em _assert_operation_allowed e
    _assert_competitor_limit_allowed, só que exposta pra decisão de UI em vez
    de bloqueio de escrita)."""
    used_operations: set[str] = set()
    used_competitor_ids: set[int] = set()
    if current_user.org_member_ids:
        rows = (
            db.query(Competitor.operation, Competitor.id)
            .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
            .filter(CompetitorTracker.user_id.in_(current_user.org_member_ids))
            .distinct()
            .all()
        )
        used_operations = {r[0] for r in rows}
        used_competitor_ids = {r[1] for r in rows}
    return {
        "maxOperations": current_user.org_max_operations,
        "usedOperations": sorted(used_operations),
        "maxCompetitors": current_user.org_max_competitors,
        "usedCompetitors": len(used_competitor_ids),
    }


@router.get("/summary-by-user")
def summary_by_user(db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)):
    """Painel de auditoria do admin — quantos concorrentes cada usuário
    rastreia, por operação, e quantos alertas já foram gerados pras lojas
    que rastreia (métrica de uso — separa quem usa de verdade de conta
    esquecida). Nomes de usuário não existem aqui (app_users vive no banco
    do app Node, ver api/deps.py) — o frontend cruza esse `user_id` com a
    lista de /api/admin/users que já busca pra tela de Usuários."""
    if not current_user.is_admin:
        raise HTTPException(403, "Só administradores podem ver isso.")
    rows = (
        db.query(CompetitorTracker.user_id, Competitor.operation, func.count(CompetitorTracker.id))
        .join(Competitor, Competitor.id == CompetitorTracker.competitor_id)
        .group_by(CompetitorTracker.user_id, Competitor.operation)
        .all()
    )
    by_user: dict[int, dict[str, int]] = {}
    for user_id, operation, count in rows:
        by_user.setdefault(user_id, {})[operation] = count

    alert_rows = (
        db.query(CompetitorTracker.user_id, func.count(Alert.id))
        .join(Competitor, Competitor.id == CompetitorTracker.competitor_id)
        .join(Alert, Alert.competitor_id == Competitor.id)
        .group_by(CompetitorTracker.user_id)
        .all()
    )
    alerts_by_user = dict(alert_rows)

    return [
        {
            "user_id": user_id,
            "by_operation": operations,
            "total": sum(operations.values()),
            "alerts_total": alerts_by_user.get(user_id, 0),
        }
        for user_id, operations in by_user.items()
    ]


@router.get("/search-trackers")
def search_trackers(
    q: str,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    """Busca admin: qual usuário rastreia tal loja — digita um pedaço do
    domínio ou nome e recebe, pra cada concorrente que bater, quem rastreia
    (varre TODOS os concorrentes do banco, não só os de quem chamou —
    diferente de list_competitors/_owned_query, por isso admin-only)."""
    if not current_user.is_admin:
        raise HTTPException(403, "Só administradores podem buscar por todos os usuários.")
    term = q.strip()
    if len(term) < 2:
        return []
    like = f"%{term}%"
    rows = (
        db.query(Competitor)
        .options(selectinload(Competitor.trackers))
        .filter(or_(Competitor.domain.ilike(like), Competitor.name.ilike(like)))
        .order_by(Competitor.name)
        .limit(20)
        .all()
    )
    return [
        {
            "competitor_id": c.id,
            "domain": c.domain,
            "name": c.name,
            "operation": c.operation,
            "tracker_user_ids": [t.user_id for t in c.trackers],
        }
        for c in rows
    ]


@router.get("/operations-usage")
def operations_usage(
    user_ids: str,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    """Quantos países distintos e quantos concorrentes distintos os
    concorrentes de um grupo de usuários já usam — pra tela admin de
    Organizações mostrar "X de Y países" e "X de Y concorrentes" por
    organização (o Node manda os `user_ids` de quem é da mesma organização;
    aqui só soma, não sabe nada de plano/organização, isso é concern do
    Node)."""
    if not current_user.is_admin:
        raise HTTPException(403, "Só administradores podem ver isso.")
    ids = [int(v) for v in user_ids.split(",") if v.strip().isdigit()]
    if not ids:
        return {"operations": [], "count": 0, "competitorsCount": 0}
    rows = (
        db.query(Competitor.operation, Competitor.id)
        .join(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.user_id.in_(ids))
        .distinct()
        .all()
    )
    ops = sorted({r[0] for r in rows})
    competitor_ids = {r[1] for r in rows}
    return {"operations": ops, "count": len(ops), "competitorsCount": len(competitor_ids)}


@router.post("/claim-orphaned")
def claim_orphaned(db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)):
    """Concorrente sem NENHUM rastreador (órfão) vira do usuário que chamar
    isso — cobre tanto quem nunca tinha dono (época pré-multi-tenant) quanto
    qualquer coisa que fique órfã por outro motivo no futuro. Admin-only de
    propósito, mesma razão do antigo claim-unowned (v1, baseado em owner_id,
    já removido): não pode virar um jeito de qualquer conta "roubar" dado
    velho sem dono."""
    if not current_user.is_admin:
        raise HTTPException(403, "Só administradores podem reivindicar concorrentes órfãos.")
    orphaned_ids = [
        row[0]
        for row in db.query(Competitor.id)
        .outerjoin(CompetitorTracker, CompetitorTracker.competitor_id == Competitor.id)
        .filter(CompetitorTracker.id.is_(None))
        .all()
    ]
    for competitor_id in orphaned_ids:
        db.add(CompetitorTracker(competitor_id=competitor_id, user_id=current_user.id))
    db.commit()
    return {"claimed": len(orphaned_ids)}


@router.post("/run-retention-now")
def run_retention_now(current_user: CurrentUser = Depends(get_current_user)):
    """Roda a limpeza de histórico (app/tasks/retention.py) na hora, direto
    na thread da requisição — sem depender do Celery Beat/fila. Criado
    depois que a execução automática de madrugada (2026-08-29, 3h Bogotá)
    não deixou nenhum rastro de ter sido processada de verdade pelo worker
    (só o Beat mandando pra fila, nada de "recebida"/"concluída"/erro nos
    logs) — dá pra confirmar ao vivo em vez de esperar até a próxima
    madrugada pra saber se funcionou."""
    if not current_user.is_admin:
        raise HTTPException(403, "Só administradores podem rodar isso.")
    return run_purge()


@router.get("/celery-diagnostics")
def celery_diagnostics(current_user: CurrentUser = Depends(get_current_user)):
    """Diagnóstico ao vivo (2026-08-30): `purge-old-history-daily-3am` é
    "enviada" pelo Beat certinho às 3h (Bogotá) dois dias seguidos, mas
    nenhum worker nunca loga "recebida"/"concluída"/erro nenhum pra ela —
    diferente de TODAS as outras tarefas agendadas (inclusive outra diária
    no mesmo formato, `ads-monitor-daily-8am`, que recebe e roda normal).
    Isso pergunta DIRETO pros workers conectados (via Redis, RPC do próprio
    Celery) se `app.tasks.retention.purge_old_history` está registrada e em
    qual fila cada worker está escutando de verdade — tira a dúvida sem
    precisar esperar a próxima madrugada de novo."""
    if not current_user.is_admin:
        raise HTTPException(403, "Só administradores podem ver isso.")
    inspect = celery_app.control.inspect(timeout=5)
    return {
        "registered": inspect.registered() or {},
        "active_queues": inspect.active_queues() or {},
        "ping": inspect.ping() or {},
    }


@router.get("/protected-stores/check")
def check_protected_store(domain: str, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)):
    """Achado ao vivo (2026-08-31): proteger uma loja só bloqueava o
    CADASTRO dela em Concorrentes (register_competitor) — mas "Buscar
    Fornecedor" e "Espionar Loja" (rotas do Node em server.js, `/api/buscar`
    `/api/spy` `/api/spy-preview`) buscam a URL direto, sem passar por
    register_competitor nenhum, então continuavam trazendo dado de uma loja
    "protegida" numa dessas duas telas. Sem endpoint dedicado, o Node não
    tem como saber quais domínios estão protegidos (a tabela vive só aqui,
    banco do FastAPI) — qualquer usuário logado pode chamar isso (não só
    admin), porque o Node chama pra QUALQUER busca, não só as de admin."""
    return {"protected": db.query(ProtectedStore).filter(ProtectedStore.domain == normalize_domain(domain)).first() is not None}


# Precisam ficar ANTES de /{competitor_id} — mesmo motivo do /hot em
# products.py: uma rota literal como essa nunca bateria com um int de
# qualquer forma, mas mantém o padrão já usado no resto do arquivo.
@router.get("/protected-stores", response_model=list[ProtectedStoreOut])
def list_protected_stores(db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)):
    if not current_user.is_admin:
        raise HTTPException(403, "Só administradores podem ver isso.")
    return db.query(ProtectedStore).order_by(ProtectedStore.created_at.desc()).all()


@router.post("/protected-stores", response_model=ProtectedStoreOut, status_code=201)
def add_protected_store(
    payload: ProtectedStoreCreate, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)
):
    """Protege um domínio pra sempre (ver models/competitor.py:ProtectedStore).

    Achado ao vivo (2026-08-29): proteger uma loja que já tinha sido
    rastreada antes só travava a captura FUTURA (status vira NOT_SHOPIFY, os
    jobs recorrentes ignoram) — mas o que já tinha sido raspado (produtos,
    duplicadas, anúncios, histórico) continuava tudo visível na tela, porque
    só o status mudava. Pedido do usuário: fingir que a loja nunca foi
    Shopify de verdade, então agora TAMBÉM apaga tudo que já existia (mesma
    cascata que `delete_competitor` usa pra apagar um concorrente inteiro:
    produtos, anúncios, alertas, snapshots — só que aqui a linha do
    Competitor em si fica, com status NOT_SHOPIFY, pra continuar aparecendo
    como "essa loja não deu certo" pra quem já rastreava)."""
    if not current_user.is_admin:
        raise HTTPException(403, "Só administradores podem proteger lojas.")
    domain = normalize_domain(payload.domain)
    existing = db.query(ProtectedStore).filter(ProtectedStore.domain == domain).first()
    if existing:
        raise HTTPException(409, f"{domain} já está protegida.")
    protected = ProtectedStore(domain=domain, note=payload.note, added_by_user_id=current_user.id)
    db.add(protected)

    competitor = db.query(Competitor).filter(Competitor.domain == domain).first()
    if competitor is not None:
        competitor.status = CompetitorStatus.NOT_SHOPIFY
        competitor.products = []
        competitor.tech_stack = []
        competitor.ads = []
        competitor.daily_volumes = []
        competitor.alerts = []
        competitor.structure_snapshots = []
        competitor.total_products = 0
        competitor.vendor_count = 0
        competitor.price_min = None
        competitor.price_max = None
        competitor.price_avg = None
        competitor.classification = None
        competitor.avg_daily_volume = None
        competitor.hot_products = 0

    db.commit()
    db.refresh(protected)
    return protected


@router.delete("/protected-stores/{protected_store_id}", status_code=204)
def remove_protected_store(
    protected_store_id: int, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)
):
    if not current_user.is_admin:
        raise HTTPException(403, "Só administradores podem remover proteção de lojas.")
    protected = db.get(ProtectedStore, protected_store_id)
    if protected is None:
        raise HTTPException(404, "Proteção não encontrada.")
    db.delete(protected)
    db.commit()


@router.get("/{competitor_id}", response_model=CompetitorDetailOut)
def get_competitor(
    competitor_id: int,
    as_user_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    target_user = resolve_target_user(current_user, as_user_id)
    competitor = (
        _owned_query(db, target_user)
        .options(selectinload(Competitor.tech_stack))
        .filter(Competitor.id == competitor_id)
        .first()
    )
    if not competitor:
        raise HTTPException(404, "Concorrente não encontrado")
    return competitor


@router.patch("/{competitor_id}", response_model=CompetitorOut)
def update_competitor(
    competitor_id: int,
    payload: CompetitorUpdate,
    db: Session = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
):
    competitor = _owned_query(db, current_user.id).filter(Competitor.id == competitor_id).first()
    if not competitor:
        raise HTTPException(404, "Concorrente não encontrado")
    if payload.status is not None:
        competitor.status = payload.status
    if payload.niche is not None:
        competitor.niche = payload.niche
    if payload.tags is not None:
        competitor.tags = payload.tags
    if payload.operation is not None and payload.operation != competitor.operation:
        _assert_operation_allowed(db, current_user, payload.operation)
        competitor.operation = payload.operation
    db.commit()
    db.refresh(competitor)
    return competitor


@router.delete("/{competitor_id}", status_code=204)
def delete_competitor(
    competitor_id: int, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)
):
    competitor = _owned_query(db, current_user.id).filter(Competitor.id == competitor_id).first()
    if not competitor:
        raise HTTPException(404, "Concorrente não encontrado")

    tracker = (
        db.query(CompetitorTracker)
        .filter(CompetitorTracker.competitor_id == competitor_id, CompetitorTracker.user_id == current_user.id)
        .first()
    )
    db.delete(tracker)
    db.flush()

    # Ninguém mais rastreando = sem razão pra guardar (decisão explícita do
    # usuário) — apaga o concorrente inteiro (cascata: produtos, anúncios,
    # alertas, snapshots). Se outro usuário ainda rastreia, só a linha dele
    # em competitor_trackers some — o dado raspado continua servindo quem
    # ainda rastreia.
    remaining = db.query(CompetitorTracker).filter(CompetitorTracker.competitor_id == competitor_id).count()
    if remaining == 0:
        db.delete(competitor)
    db.commit()


@router.post("/{competitor_id}/rescan-ads", status_code=202)
def rescan_ads(
    competitor_id: int, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)
):
    # Fora do cron diário (ver tasks/ads_monitor.py) — pra concorrente que já
    # existia antes de um fix no scraper entrar no ar (caso real: bug de
    # falso-negativo corrigido em scrapers/meta_ads.py deixava um concorrente
    # ativo sem NENHUM anúncio na tela até o próximo cron das 8h; isso deixa
    # forçar o re-scan na hora em vez de esperar até amanhã).
    competitor = _owned_query(db, current_user.id).filter(Competitor.id == competitor_id).first()
    if not competitor:
        raise HTTPException(404, "Concorrente não encontrado")
    if competitor.status != CompetitorStatus.ACTIVE:
        raise HTTPException(400, "Concorrente não está ativo")
    _enqueue(run_ads_monitor_one, competitor.id, label=f"o rescan de anúncios de {competitor.domain}")
    return {"status": "queued"}


@router.post("/{competitor_id}/rescore", status_code=202)
def rescore(competitor_id: int, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)):
    # Score (services/scoring_service.py) só recalcula no snapshot diário
    # (6h). Sem isso, corrigir um dado que o score usa (ex: bug real de
    # started_at do anúncio vindo em inglês e nunca sendo parseado — ver
    # scrapers/meta_ads.py) só refletia em "Produtos Quentes" no dia
    # seguinte, mesmo com o dado já certo no banco.
    competitor = _owned_query(db, current_user.id).filter(Competitor.id == competitor_id).first()
    if not competitor:
        raise HTTPException(404, "Concorrente não encontrado")
    if competitor.status != CompetitorStatus.ACTIVE:
        raise HTTPException(400, "Concorrente não está ativo")
    _enqueue(run_daily_snapshot_one, competitor.id, label=f"o recálculo de score de {competitor.domain}")
    return {"status": "queued"}
