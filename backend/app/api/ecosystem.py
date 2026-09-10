"""Módulo 2.5 — fornecedores compartilhados entre lojas concorrentes."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import CurrentUser, get_current_user
from app.database import get_db
from app.services.ecosystem_service import find_shared_vendors

router = APIRouter(prefix="/api/ecosystem", tags=["ecosystem"])


@router.get("/shared-vendors")
def shared_vendors(
    min_stores: int = 2, db: Session = Depends(get_db), current_user: CurrentUser = Depends(get_current_user)
):
    return find_shared_vendors(db, user_id=current_user.id, min_stores=min_stores)
