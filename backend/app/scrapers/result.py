"""Tipo de retorno compartilhado pelos 3 scrapers de anúncio (meta_ads,
google_ads, tiktok_ads).

Existe pra separar "escaneei e não achei nada" de "a busca falhou" (timeout,
bloqueio, erro de rede). Antes disso, os 3 scrapers devolviam `list[dict]`
puro e um `except Exception: return []` genérico — bug real encontrado ao
vivo: o Google Ads Transparency deu timeout escaneando uma loja que
comprovadamente tinha 4 anúncios ativos lá (confirmados minutos antes numa
outra tela), e o Minerador de Anúncios mostrou "0 anúncios" como se fosse um
resultado normal, com a nota de "cobertura baixa é característica da
ferramenta" — passando a entender uma FALHA como um SINAL. `failed=True`
deixa quem usa o resultado (services/ad_miner_service.py, tasks/ads_monitor.py)
mostrar isso como "não deu pra confirmar agora", nunca como "a loja não
anuncia aqui"."""

from dataclasses import dataclass, field


@dataclass
class ScrapeResult:
    ads: list[dict] = field(default_factory=list)
    failed: bool = False
    error: str | None = None
