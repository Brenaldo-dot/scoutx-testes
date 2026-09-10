"""Identidade do usuário logado, repassada pelo proxy Node (server.js).

O FastAPI nunca teve conceito de usuário — sempre confiou cegamente em
qualquer coisa vinda do proxy. Multi-tenant (cada usuário só vê os próprios
concorrentes) exige saber QUEM está pedindo; como app_users vive num banco
Postgres separado (o do app Node), não dá pra ter FK de verdade aqui — o
Node manda o id em um header a cada chamada de /api/minerador/*
(ver server.js), e este arquivo só lê esse header. Mesmo modelo de confiança
que já existia pra permissão de admin (nunca foi validado com assinatura),
só que agora explícito por usuário em vez de só um proxy geral.

Revisão de segurança: X-Internal-Secret (config.py:internal_api_secret) é a
segunda camada — sem ela, qualquer requisição que chegasse direto neste
serviço (sem passar pelo proxy Node) conseguia forjar QUALQUER identidade,
inclusive admin, só mandando os headers certos. A única proteção antes disso
era o serviço não ter domínio público, o que já se mostrou frágil na
prática. Ver INTERNAL_API_SECRET no server.js do proxy.
"""

import secrets

from fastapi import Header, HTTPException

from app.config import get_settings


class CurrentUser:
    def __init__(
        self,
        id: int,
        is_admin: bool,
        org_member_ids: list[int] | None = None,
        org_max_operations: int | None = None,
        org_max_competitors: int | None = None,
        org_plan: str | None = None,
    ):
        self.id = id
        self.is_admin = is_admin
        # Limite de países e de concorrentes do plano (Módulo de
        # planos/organizações) — quem mais são os colegas de organização e os
        # tetos dela, ambos calculados no Node (onde vive a tabela
        # organizations) e passados em header confiável a cada request.
        # None = sem organização/sem limite (conta admin, ou plano Enterprise).
        self.org_member_ids = org_member_ids or []
        self.org_max_operations = org_max_operations
        self.org_max_competitors = org_max_competitors
        # Chave interna do plano (solo/pro/agencia, ver PLAN_LIMITS em db.js
        # no Node) — None pra conta admin (sem organização). Usado só pra
        # travar feature específica de plano (hoje: alerta no Discord e
        # histórico completo de Alertas, exclusivos de Pro+) — diferente dos
        # tetos numéricos acima, aqui interessa a IDENTIDADE do plano, não
        # um número.
        self.org_plan = org_plan

    @property
    def is_standard_plan(self) -> bool:
        return self.org_plan == "solo"


def get_current_user(
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    x_user_is_admin: str | None = Header(default=None, alias="X-User-Is-Admin"),
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
    x_org_member_ids: str | None = Header(default=None, alias="X-Org-Member-Ids"),
    x_org_max_operations: str | None = Header(default=None, alias="X-Org-Max-Operations"),
    x_org_max_competitors: str | None = Header(default=None, alias="X-Org-Max-Competitors"),
    x_org_plan: str | None = Header(default=None, alias="X-Org-Plan"),
) -> CurrentUser:
    settings = get_settings()
    if settings.internal_api_secret and not secrets.compare_digest(
        x_internal_secret or "", settings.internal_api_secret
    ):
        # 404 (não 401/403) de propósito: não devolve nenhum sinal de que
        # existe uma API aqui pra quem tentar direto sem passar pelo proxy.
        raise HTTPException(404, "Não encontrado")
    if not x_user_id or not x_user_id.isdigit():
        raise HTTPException(401, "Identidade do usuário não veio na requisição (header X-User-Id ausente)")

    member_ids = [int(v) for v in x_org_member_ids.split(",") if v.strip().isdigit()] if x_org_member_ids else []
    max_operations = int(x_org_max_operations) if x_org_max_operations and x_org_max_operations.isdigit() else None
    max_competitors = (
        int(x_org_max_competitors) if x_org_max_competitors and x_org_max_competitors.isdigit() else None
    )

    return CurrentUser(
        id=int(x_user_id),
        is_admin=x_user_is_admin == "true",
        org_member_ids=member_ids,
        org_max_operations=max_operations,
        org_max_competitors=max_competitors,
        org_plan=x_org_plan or None,
    )


def resolve_target_user(current_user: CurrentUser, as_user_id: int | None) -> int:
    """`as_user_id` é como o admin pede pra ver a lista de outra pessoa
    (painel de auditoria) — qualquer um tentando ver o de outro usuário sem
    ser admin toma 403. Sem `as_user_id`, todo mundo (admin incluso) vê só
    a própria lista."""
    if as_user_id is not None and as_user_id != current_user.id:
        if not current_user.is_admin:
            raise HTTPException(403, "Só administradores podem ver a lista de outro usuário.")
        return as_user_id
    return current_user.id
