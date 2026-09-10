from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

settings = get_settings()

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    future=True,
    # Default do SQLAlchemy (pool_size=5 + max_overflow=10 = 15) estourou ao
    # vivo (QueuePool limit... connection timed out) numa rajada de ~20
    # requests concorrentes de recálculo de score — com ~45 concorrentes
    # cadastrados hoje e captura de preço ficando mais frequente (várias
    # vezes por dia, não só 1x), o app precisa de mais margem por processo
    # (web + worker Celery cada um com seu próprio pool).
    pool_size=10,
    max_overflow=20,
    pool_recycle=1800,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
