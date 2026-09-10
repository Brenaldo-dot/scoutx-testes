"""
Módulo 2.2 — agrupamento de páginas duplicadas (sinal de escala).

Reescrito: a primeira versão comparava só similaridade de título dentro do
mesmo vendor (difflib) e, testada ao vivo contra uma loja real
(allbirds.com), deu 75 de 80 falsos positivos — uma marca legítima com o
mesmo modelo em várias cores/tamanhos como produtos separados tem títulos
parecidos sob o mesmo vendor sem ser o padrão de duplicação que o sinal quer
capturar.

Esta versão agrupa por dois sinais bem mais confiáveis — a mesma ideia por
trás do "câmera 1 / câmera 2" (a página 2 é a página 1 republicada com copy
diferente):
1. Mesmo `supplier_id` (barcode/SKU real do fornecedor — scrapers/supplier_id.py)
2. Pelo menos uma imagem reaproveitada entre as páginas (mesmo caminho de
   arquivo), mesmo com título/descrição diferentes

União por union-find: dois produtos que compartilham qualquer um dos dois
sinais caem no mesmo grupo, e o grupo pode crescer por transitividade
(A com B por imagem, B com C por supplier_id → A, B, C no mesmo grupo).

Também PROPAGA supplier_id dentro de cada grupo (efeito colateral, ver
`cluster_duplicate_listings`): testado ao vivo contra uma loja real, um grupo
de 8 páginas — a mesma câmera com 8 títulos de copy diferentes — só tinha
barcode publicado em 1 das 8. Como o agrupamento já provou que são a mesma
oferta (via imagem reaproveitada), faz sentido propagar o código conhecido
pras outras 7 em vez de mostrar "sem ID" pra um produto que sabidamente tem
ID — só não estava publicado NAQUELA página específica.
"""

from urllib.parse import urlparse


def image_key(src: str | None) -> str | None:
    if not src:
        return None
    try:
        path = urlparse(src).path
    except ValueError:
        path = src
    return path.lower() or None


class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def cluster_duplicate_listings(products: list[dict]) -> dict[int, list[dict]]:
    """
    Recebe produtos normalizados (Módulo 2.1, precisa de `supplier_id` e
    `image_urls`) e devolve um dict shopify_product_id -> lista de OUTRAS
    páginas no mesmo grupo (cada uma como {"shopify_product_id", "title"}).
    Lista vazia = nenhuma duplicata conhecida pra esse produto.

    Efeito colateral: quando um grupo tem pelo menos um `supplier_id`
    conhecido, escreve esse valor de volta em `product["supplier_id"]` de
    todos os membros do grupo que ainda estavam sem (in-place, quem chama
    não precisa fazer nada extra — só usar `products` depois desta chamada).
    """
    n = len(products)
    uf = _UnionFind(n)

    by_supplier: dict[str, list[int]] = {}
    by_image: dict[str, list[int]] = {}

    for i, p in enumerate(products):
        supplier_id = p.get("supplier_id")
        if supplier_id:
            by_supplier.setdefault(supplier_id, []).append(i)
        for src in p.get("image_urls") or []:
            key = image_key(src)
            if key:
                by_image.setdefault(key, []).append(i)

    for indices in by_supplier.values():
        for i in indices[1:]:
            uf.union(indices[0], i)
    for indices in by_image.values():
        if len(indices) > 1:
            for i in indices[1:]:
                uf.union(indices[0], i)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        root = uf.find(i)
        groups.setdefault(root, []).append(i)

    for indices in groups.values():
        if len(indices) < 2:
            continue
        known_id = next((products[i]["supplier_id"] for i in indices if products[i].get("supplier_id")), None)
        if known_id:
            for i in indices:
                if not products[i].get("supplier_id"):
                    products[i]["supplier_id"] = known_id

    result: dict[int, list[dict]] = {}
    for i, p in enumerate(products):
        root = uf.find(i)
        others = [
            {"shopify_product_id": products[j]["shopify_product_id"], "title": products[j]["title"]}
            for j in groups[root]
            if j != i
        ]
        result[p["shopify_product_id"]] = others
    return result
