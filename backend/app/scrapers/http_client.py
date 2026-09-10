"""
Cliente HTTP compartilhado pelos scrapers.

A rotação de proxy e o rate limiting existem para distribuir a carga de
monitorar muitas lojas todo dia sem martelar um único IP — não para burlar
autenticação ou acessar áreas não-públicas de um site.

Revisão de segurança: achada num teste de invasão. `domain` (o que vira a
URL de TODA requisição daqui) é 100% controlado por quem cadastra o
concorrente — qualquer usuário logado pode registrar qualquer string como
domínio (ver services/competitor_service.py:normalize_domain, que só mexe em
texto, nunca valida host). Sem checagem nenhuma, esse cliente virava uma
ponte pra sondar (ou, no caso de api/products.py:preview_product_page, que
segue redirecionamento e devolve a resposta pro chamador, LER de verdade) a
rede interna do Railway — onde este próprio backend roda, ao lado de
Postgres/Redis. Mesmo problema, mesma causa raiz e mesma correção já
aplicados do lado Node (buscar-barcode-shopify-web/safe-fetch.js): resolve e
valida o hostname, e FIXA (pin) a conexão nesse endereço já validado pro
resto da sessão daquele client — reresolver DNS a cada requisição reabriria
a janela de "DNS rebinding" (responder um IP público na validação e um IP
interno na conexão de verdade, segundos depois). `domain` agora é
obrigatório em build_async_client() de propósito: força toda chamada
existente a passar por aqui, em vez de deixar alguém esquecer de validar um
client novo no futuro.
"""

import asyncio
import ipaddress
import itertools
import socket

import httpx

from app.config import get_settings

settings = get_settings()
_proxy_cycle = itertools.cycle(settings.proxy_list) if settings.proxy_list else None


def _next_proxy() -> str | None:
    return next(_proxy_cycle) if _proxy_cycle else None


class SSRFBlockedError(Exception):
    """Domínio recusado por resolver pra um endereço que não é público."""


_BLOCKED_HOST_SUFFIXES = (".localhost", ".local", ".internal", ".railway.internal")


def _is_blocked_ip(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


async def _resolve_public_ip(hostname: str) -> str:
    """Resolve o hostname, valida TODOS os endereços que ele responder, e
    devolve um deles já validado — pra fixar a conexão nele."""
    host = hostname.strip().lower()
    if not host or host == "localhost" or host.endswith(_BLOCKED_HOST_SUFFIXES):
        raise SSRFBlockedError(f"Endereço não permitido: {hostname!r}")
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise SSRFBlockedError(f"Não foi possível resolver: {hostname!r}") from exc
    addresses = list(dict.fromkeys(info[4][0] for info in infos))
    if not addresses:
        raise SSRFBlockedError(f"Não foi possível resolver: {hostname!r}")
    for address in addresses:
        if _is_blocked_ip(address):
            raise SSRFBlockedError(f"Endereço não permitido: {hostname!r}")
    return addresses[0]


class _PinnedTransport(httpx.AsyncBaseTransport):
    """Encaminha pro transporte real, mas troca o host da URL pelo IP já
    validado — o hostname original continua indo no Host e no SNI (extension
    `sni_hostname`, suportada nativamente pelo httpx pra esse exato cenário),
    então lojas atrás de CDN/hosting compartilhado continuam funcionando
    normal. Como a URL já aponta pro IP fixo, um redirecionamento pra outro
    host não escaparia pra lugar nenhum sozinho — de qualquer forma,
    `follow_redirects=False` (ver build_async_client) já impede o cliente de
    seguir automaticamente."""

    def __init__(self, wrapped: httpx.AsyncBaseTransport, hostname: str, pinned_ip: str):
        self._wrapped = wrapped
        self._hostname = hostname
        self._pinned_ip = pinned_ip

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        request.url = request.url.copy_with(host=self._pinned_ip)
        request.headers["host"] = self._hostname
        request.extensions["sni_hostname"] = self._hostname
        return await self._wrapped.handle_async_request(request)

    async def aclose(self) -> None:
        await self._wrapped.aclose()


async def build_async_client(domain: str, **overrides) -> httpx.AsyncClient:
    headers = {
        "User-Agent": settings.scraper_user_agent,
        "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-CO,es;q=0.9,pt-BR;q=0.8",
    }
    kwargs = {
        "headers": headers,
        "timeout": httpx.Timeout(20.0),
        # Desligado de propósito (era True): seguir redirect automaticamente
        # pra uma URL nova ignoraria o pin abaixo e reabriria a mesma brecha
        # de SSRF pro host que o redirect apontar. Quem chama já trata
        # resposta não-2xx como erro (ver response.raise_for_status()).
        "follow_redirects": False,
    }
    proxy = _next_proxy()
    kwargs.update(overrides)

    pinned_ip = await _resolve_public_ip(domain)
    base_transport = httpx.AsyncHTTPTransport(proxy=proxy)
    kwargs["transport"] = _PinnedTransport(base_transport, domain, pinned_ip)

    return httpx.AsyncClient(**kwargs)
