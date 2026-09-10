import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, ForeignKey, Integer, JSON, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class CompetitorStatus(str, enum.Enum):
    # Estado inicial de todo cadastro novo — verificação (é Shopify mesmo?)
    # e raio-x rodam em background (tasks/onboarding.py) pra não travar o
    # formulário esperando (a Shopify pode levar até ~85s sob rate limit,
    # ver scrapers/shopify.py); usuário pediu especificamente pra poder
    # colar a próxima loja sem esperar a anterior terminar.
    CHECKING = "checking"
    ACTIVE = "active"
    PAUSED = "paused"
    NOT_SHOPIFY = "not_shopify"


class ScaleClassification(str, enum.Enum):
    TESTING = "testando"
    MEDIUM = "operacao_media"
    SCALING = "escalando"


class Competitor(Base):
    __tablename__ = "competitors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Domínio único GLOBAL de novo (não mais por dono) — o dado raspado de
    # uma loja é UM só, compartilhado por quem quer que a rastreie; quem
    # rastreia o quê vive em CompetitorTracker, não aqui. Ver
    # services/competitor_service.py:register_competitor: dois usuários
    # cadastrando o MESMO domínio reaproveitam esta MESMA linha (sem raspar
    # de novo, sem duplicar trabalho de background), cada um só ganha uma
    # linha em competitor_trackers — nunca um "herda" silenciosamente o
    # cadastro do outro, só quando cadastra o mesmo domínio ele mesmo.
    domain: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    niche: Mapped[str | None] = mapped_column(String(120), nullable=True)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    # Módulo 1.2 — separa operações que não devem se misturar na tela (ex:
    # Colômbia vs México): todo concorrente pertence a uma só operação, e
    # cada tela filtra por ela. Coluna nova numa tabela que já tinha dado em
    # produção — `create_all` não altera tabela existente, backfill é feito
    # via ALTER na lifespan de main.py (mesmo padrão do fix de shopify_product_id).
    operation: Mapped[str] = mapped_column(String(50), default="colombia", nullable=False, index=True)

    status: Mapped[CompetitorStatus] = mapped_column(
        Enum(CompetitorStatus, native_enum=False), default=CompetitorStatus.ACTIVE, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Cache do último raio-x (Módulo 2.3) para leitura rápida no dashboard.
    # Histórico completo fica em StoreStructureSnapshot.
    total_products: Mapped[int] = mapped_column(Integer, default=0)
    vendor_count: Mapped[int] = mapped_column(Integer, default=0)
    price_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_max: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_avg: Mapped[float | None] = mapped_column(Float, nullable=True)
    classification: Mapped[ScaleClassification | None] = mapped_column(
        Enum(ScaleClassification, native_enum=False), nullable=True
    )
    avg_daily_volume: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Quantos produtos ATIVOS dessa loja têm score 56+ (Quente OU Escalando —
    # MESMO corte de min_score usado em /api/products/hot, a aba "Produtos
    # Quentes"). Primeira versão usava só Product.scaling (score 80+, faixa
    # "Escalando" pura) e ficava quase sempre em 0/1 mesmo com a aba Produtos
    # Quentes cheia — sinal "anúncios crescendo" que fecha os 80 pontos
    # sozinho é raro; a maioria dos produtos quentes chega no 56-79 somando
    # sinais mais fracos (ver scoring_service.py). Esse card mostra a MESMA
    # população da aba Produtos Quentes, por loja. Atualizado todo dia junto
    # do resto do snapshot (tasks/daily_snapshot.py).
    hot_products: Mapped[int] = mapped_column(Integer, default=0)

    products: Mapped[list["Product"]] = relationship(back_populates="competitor", cascade="all, delete-orphan")
    tech_stack: Mapped[list["TechStack"]] = relationship(back_populates="competitor", cascade="all, delete-orphan")
    ads: Mapped[list["Ad"]] = relationship(back_populates="competitor", cascade="all, delete-orphan")
    daily_volumes: Mapped[list["DailyVolume"]] = relationship(
        back_populates="competitor", cascade="all, delete-orphan"
    )
    alerts: Mapped[list["Alert"]] = relationship(back_populates="competitor", cascade="all, delete-orphan")
    structure_snapshots: Mapped[list["StoreStructureSnapshot"]] = relationship(
        back_populates="competitor", cascade="all, delete-orphan", order_by="StoreStructureSnapshot.captured_at"
    )
    trackers: Mapped[list["CompetitorTracker"]] = relationship(back_populates="competitor", cascade="all, delete-orphan")


class CompetitorTracker(Base):
    """Quem rastreia qual concorrente — multi-tenant sem duplicar o dado
    raspado (ver Competitor.domain acima). Uma linha aqui = "usuário X tem
    esse concorrente na lista dele". Apagar a ÚLTIMA linha de um competitor_id
    apaga o Competitor inteiro (ninguém mais rastreando = sem razão de
    guardar, decisão explícita do usuário) — ver
    api/competitors.py:delete_competitor."""

    __tablename__ = "competitor_trackers"
    __table_args__ = (UniqueConstraint("competitor_id", "user_id", name="uq_tracker_competitor_user"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    competitor_id: Mapped[int] = mapped_column(ForeignKey("competitors.id", ondelete="CASCADE"), index=True)
    # id de app_users (banco do app Node) — mesma limitação de FK entre
    # bancos diferentes que Competitor.owner_id tinha, ver api/deps.py.
    user_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    competitor: Mapped["Competitor"] = relationship(back_populates="trackers")


class StoreStructureSnapshot(Base):
    """Histórico do raio-x (Módulo 2.3) — gerado no cadastro e depois semanalmente."""

    __tablename__ = "store_structure_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    competitor_id: Mapped[int] = mapped_column(ForeignKey("competitors.id"), index=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    total_products: Mapped[int] = mapped_column(Integer, default=0)
    vendor_count: Mapped[int] = mapped_column(Integer, default=0)
    price_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_max: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_avg: Mapped[float | None] = mapped_column(Float, nullable=True)
    products_with_variants: Mapped[int] = mapped_column(Integer, default=0)
    products_without_variants: Mapped[int] = mapped_column(Integer, default=0)
    classification: Mapped[ScaleClassification] = mapped_column(Enum(ScaleClassification, native_enum=False))

    competitor: Mapped["Competitor"] = relationship(back_populates="structure_snapshots")


class ProtectedStore(Base):
    """Lojas que o app nunca deve vasculhar (pedido do admin, 2026-08-29) —
    ex: a própria loja da equipe, um parceiro, ou qualquer domínio que pediu
    pra ficar de fora. Cadastrado aqui, o domínio NUNCA chega a ser raspado
    nem uma vez: `register_competitor` intercepta ANTES da verificação real
    (services/competitor_service.py) e marca direto como NOT_SHOPIFY — o
    mesmo status/selo que já existe pra loja que não é Shopify de verdade,
    reaproveitado de propósito (nenhuma tela precisa saber a diferença: pra
    quem cadastra, o resultado visual é idêntico ao de uma loja que
    simplesmente não deu pra minerar). Os jobs recorrentes (daily_snapshot,
    weekly_xray, ads_monitor) já só rodam em `status == ACTIVE`, então nada
    mais precisa mudar pra loja que já estava sendo rastreada ANTES de virar
    protegida — proteger também derruba o status dela pra NOT_SHOPIFY (ver
    api/competitors.py:add_protected_store), parando qualquer captura futura."""

    __tablename__ = "protected_stores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    domain: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # id de app_users (banco do Node) — mesmo padrão de CompetitorTracker.user_id.
    added_by_user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
