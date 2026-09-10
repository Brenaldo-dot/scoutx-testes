"""Módulo 2.3 — análise de estrutura da loja."""

from statistics import mean

from app.models.competitor import ScaleClassification


def analyze_structure(products: list[dict]) -> dict:
    """Recebe produtos normalizados (Módulo 2.1) e devolve os agregados da loja."""
    total = len(products)
    prices = [p["price_min"] for p in products if p.get("price_min") is not None]
    vendors = {p["vendor"] for p in products if p.get("vendor")}
    with_variants = sum(1 for p in products if (p.get("variant_count") or 0) > 1)
    without_variants = total - with_variants

    return {
        "total_products": total,
        "vendor_count": len(vendors),
        "price_min": min(prices) if prices else None,
        "price_max": max(prices) if prices else None,
        "price_avg": round(mean(prices), 2) if prices else None,
        "products_with_variants": with_variants,
        "products_without_variants": without_variants,
        # Valor inicial honesto: no cadastro ainda não existe NENHUM sinal
        # real de escala (isso vem de score por produto — anúncio no ar,
        # anúncio crescendo etc., calculado só no snapshot diário, ver
        # tasks/daily_snapshot.py). Chutar a partir de tamanho de catálogo
        # classificava qualquer loja normal como "Escalando" sempre.
        "classification": ScaleClassification.TESTING,
    }
