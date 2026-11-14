/**
 * Servidor MCP do ScoutX: deixa a Claude consultar/mexer nos dados do Minerador
 * (concorrentes, produtos, anúncios, alertas, dashboard, ecossistema, minerador de
 * anúncios, configurações) pelo conector do claude.ai, sem precisar logar no app.
 *
 * Autenticação: um token fixo (SCOUTX_MCP_PATH_TOKEN) embutido na própria URL do
 * endpoint (mesmo padrão do meta-autopilot — sem OAuth), mapeado sempre pra UM
 * usuário fixo (SCOUTX_MCP_USER_EMAIL). Quem tiver a URL age como esse usuário.
 *
 * Em vez de reimplementar o acesso ao FastAPI, usa a MESMA lógica de headers
 * (X-User-Id/X-User-Is-Admin/X-Internal-Secret + limites de organização) que o
 * proxy /api/minerador/* já usa pra pedido vindo de sessão logada — ver server.js.
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

/** Mesma montagem de headers do proxy /api/minerador/* (server.js), pra chamar
 * o FastAPI diretamente com a identidade de um usuário fixo (não vem de sessão). */
async function callMinerador(deps, appUser, method, path, body) {
  const { db, INTERNAL_API_SECRET, MINERADOR_API_URL } = deps;
  if (!MINERADOR_API_URL) throw new Error("Minerador ainda não está configurado neste ambiente.");

  const orgHeaders = {};
  if (appUser.organization_id) {
    const memberIds = await db.getOrgMemberIds(appUser.organization_id);
    orgHeaders["X-Org-Member-Ids"] = memberIds.join(",");
    orgHeaders["X-Org-Plan"] = appUser.org_plan;
    const limits = db.planLimitsFor(appUser.org_plan);
    if (Number.isFinite(limits.maxOperations)) orgHeaders["X-Org-Max-Operations"] = String(limits.maxOperations);
    if (Number.isFinite(limits.maxCompetitors)) orgHeaders["X-Org-Max-Competitors"] = String(limits.maxCompetitors);
  }

  const url = `${MINERADOR_API_URL.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": String(appUser.id),
      "X-User-Is-Admin": appUser.role === "admin" ? "true" : "false",
      "X-Internal-Secret": INTERNAL_API_SECRET,
      ...orgHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // FastAPI/HTTPException devolve {"detail": "..."}, não {"error": "..."} (convenção do Fastify/meta-autopilot).
    const detail = data && typeof data === "object" ? data.detail : null;
    const message = typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

function qs(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

const OPERATION_DESC = "País/operação (texto livre, ex.: BR, MX) — sem informar, olha todas.";

function buildTools() {
  return [
    // ───── Concorrentes ─────
    {
      name: "list_competitors",
      description: "Lista os concorrentes rastreados (loja, status, nicho, tags, métricas).",
      shape: { status: z.string().optional(), operation: z.string().optional().describe(OPERATION_DESC) },
      handler: (deps, user, i) => callMinerador(deps, user, "GET", `/api/competitors${qs(i)}`),
    },
    {
      name: "get_competitor",
      description: "Detalhes de um concorrente: stack de tecnologia, métricas, produtos.",
      shape: { competitorId: z.number().int() },
      handler: (deps, user, { competitorId }) => callMinerador(deps, user, "GET", `/api/competitors/${competitorId}`),
    },
    {
      name: "create_competitor",
      description: "Cadastra uma loja pra rastrear (Shopify). Dispara um raio-x inicial se for loja nova no sistema.",
      shape: {
        domain: z.string().describe("Domínio da loja (ex.: lojaexemplo.com)."),
        name: z.string().describe("Nome pra identificar a loja."),
        niche: z.string().optional(),
        tags: z.array(z.string()).optional(),
        operation: z.string().describe(OPERATION_DESC),
      },
      handler: (deps, user, i) => callMinerador(deps, user, "POST", "/api/competitors", i),
    },
    {
      name: "update_competitor",
      description: "Altera status, nicho, tags ou país/operação de um concorrente já cadastrado.",
      shape: {
        competitorId: z.number().int(),
        status: z.string().optional(),
        niche: z.string().optional(),
        tags: z.array(z.string()).optional(),
        operation: z.string().optional(),
      },
      handler: (deps, user, { competitorId, ...rest }) =>
        callMinerador(deps, user, "PATCH", `/api/competitors/${competitorId}`, rest),
    },
    {
      name: "delete_competitor",
      description: "Para de rastrear um concorrente (sai da sua lista). Se mais ninguém rastrear essa loja, o dado raspado é apagado de vez. Ação irreversível: confirme com o usuário antes de chamar.",
      shape: { competitorId: z.number().int() },
      handler: async (deps, user, { competitorId }) => {
        await callMinerador(deps, user, "DELETE", `/api/competitors/${competitorId}`);
        return { ok: true };
      },
    },
    {
      name: "rescan_competitor_ads",
      description: "Força agora a releitura dos anúncios de um concorrente (fora do cron diário).",
      shape: { competitorId: z.number().int() },
      handler: (deps, user, { competitorId }) => callMinerador(deps, user, "POST", `/api/competitors/${competitorId}/rescan-ads`),
    },
    {
      name: "rescore_competitor",
      description: "Recalcula agora o score dos produtos de um concorrente (fora do snapshot diário).",
      shape: { competitorId: z.number().int() },
      handler: (deps, user, { competitorId }) => callMinerador(deps, user, "POST", `/api/competitors/${competitorId}/rescore`),
    },
    {
      name: "my_operations_limit",
      description: "Quantos países e concorrentes seu plano ainda permite cadastrar, e quanto já foi usado.",
      shape: {},
      handler: (deps, user) => callMinerador(deps, user, "GET", "/api/competitors/my-operations-limit"),
    },
    {
      name: "check_protected_store",
      description: "Confere se um domínio está na lista de lojas protegidas (não pode ser rastreado).",
      shape: { domain: z.string() },
      handler: (deps, user, { domain }) => callMinerador(deps, user, "GET", `/api/competitors/protected-stores/check${qs({ domain })}`),
    },

    // ───── Produtos ─────
    {
      name: "list_products",
      description: "Lista os produtos descobertos nas lojas rastreadas, com filtros de busca, nicho e paginação.",
      shape: {
        competitorId: z.number().int().optional(),
        operation: z.string().optional().describe(OPERATION_DESC),
        q: z.string().optional().describe("Busca pelo título do produto."),
        hotOnly: z.boolean().optional().describe("Só produtos quentes (score 56+)."),
        activeOnly: z.boolean().optional().describe("Padrão: true."),
        sort: z.enum(["recent", "duplicates", "active_ads"]).optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      handler: (deps, user, i) => {
        const { competitorId, hotOnly, activeOnly, ...rest } = i;
        return callMinerador(
          deps,
          user,
          "GET",
          `/api/products${qs({ ...rest, competitor_id: competitorId, hot_only: hotOnly, active_only: activeOnly })}`,
        );
      },
    },
    {
      name: "list_hot_products",
      description: "\"Produtos Quentes\": score alto (56+), ordenável por score, anúncios ativos ou tempo de anúncio.",
      shape: {
        minScore: z.number().int().min(0).max(100).optional(),
        operation: z.string().optional().describe(OPERATION_DESC),
        q: z.string().optional(),
        sort: z.enum(["score", "active_ads", "ad_duration"]).optional(),
        hasSupplier: z.boolean().optional().describe("Só produtos com fornecedor identificado."),
        growingOnly: z.boolean().optional().describe("Só com sinal de anúncios crescendo."),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      handler: (deps, user, i) => {
        const { minScore, hasSupplier, growingOnly, ...rest } = i;
        return callMinerador(
          deps,
          user,
          "GET",
          `/api/products/hot${qs({ ...rest, min_score: minScore, has_supplier: hasSupplier, growing_only: growingOnly })}`,
        );
      },
    },
    {
      name: "get_product",
      description: "Detalhes de um produto: eventos (novo/removido/preço/estoque) e histórico de score.",
      shape: { productId: z.number().int() },
      handler: (deps, user, { productId }) => callMinerador(deps, user, "GET", `/api/products/${productId}`),
    },

    // ───── Anúncios ─────
    {
      name: "list_ads",
      description: "Lista anúncios encontrados nas bibliotecas públicas (Meta/Google/TikTok) das lojas rastreadas.",
      shape: {
        competitorId: z.number().int().optional(),
        operation: z.string().optional().describe(OPERATION_DESC),
        productId: z.number().int().optional(),
        platform: z.enum(["meta", "google", "tiktok"]).optional(),
        winningOnly: z.boolean().optional().describe("Só anúncios marcados como vencedores."),
        sort: z.enum(["recent", "days_active"]).optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      handler: (deps, user, i) => {
        const { competitorId, productId, winningOnly, ...rest } = i;
        return callMinerador(
          deps,
          user,
          "GET",
          `/api/ads${qs({ ...rest, competitor_id: competitorId, product_id: productId, winning_only: winningOnly })}`,
        );
      },
    },

    // ───── Alertas ─────
    {
      name: "list_alerts",
      description: "Histórico de alertas (produto novo, anúncio novo, mudança de preço/estoque/fornecedor, sinais de escala...).",
      shape: {
        competitorId: z.number().int().optional(),
        operation: z.string().optional().describe(OPERATION_DESC),
        category: z.enum(["produto", "fornecedor", "anuncios", "escala", "preco_estoque", "outros"]).optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      handler: (deps, user, i) => {
        const { competitorId, ...rest } = i;
        return callMinerador(deps, user, "GET", `/api/alerts${qs({ ...rest, competitor_id: competitorId })}`);
      },
    },
    {
      name: "alert_counts",
      description: "Quantos alertas existem por categoria (produto, fornecedor, anúncios, escala, preço/estoque, outros).",
      shape: { competitorId: z.number().int().optional(), operation: z.string().optional().describe(OPERATION_DESC) },
      handler: (deps, user, i) => {
        const { competitorId, ...rest } = i;
        return callMinerador(deps, user, "GET", `/api/alerts/counts${qs({ ...rest, competitor_id: competitorId })}`);
      },
    },
    {
      name: "send_test_alert",
      description: "Dispara um alerta de teste (aparece na aba Alertas e no Discord, se configurado) — útil pra confirmar que a notificação está funcionando.",
      shape: { competitorId: z.number().int().optional().describe("Sem informar, usa o primeiro concorrente cadastrado.") },
      handler: (deps, user, { competitorId }) =>
        callMinerador(deps, user, "POST", `/api/alerts/test${qs({ competitor_id: competitorId })}`),
    },

    // ───── Dashboard ─────
    {
      name: "dashboard_summary",
      description: "Resumo geral: total de concorrentes, produtos quentes, alertas nas últimas 24h.",
      shape: { operation: z.string().optional().describe(OPERATION_DESC) },
      handler: (deps, user, i) => callMinerador(deps, user, "GET", `/api/dashboard/summary${qs(i)}`),
    },
    {
      name: "dashboard_highlights",
      description: "Destaques: produtos subindo de score rápido, anúncios vencedores ainda no ar, trocas de fornecedor recentes.",
      shape: { operation: z.string().optional().describe(OPERATION_DESC) },
      handler: (deps, user, i) => callMinerador(deps, user, "GET", `/api/dashboard/highlights${qs(i)}`),
    },
    {
      name: "activity_heatmap",
      description: "Quantos alertas por dia nas últimas N semanas (heatmap de atividade).",
      shape: { operation: z.string().optional().describe(OPERATION_DESC), weeks: z.number().int().min(1).max(53).optional() },
      handler: (deps, user, i) => callMinerador(deps, user, "GET", `/api/dashboard/activity-heatmap${qs(i)}`),
    },
    {
      name: "alerts_by_competitor",
      description: "Ranking de quais concorrentes mais geraram alerta nos últimos N dias.",
      shape: { operation: z.string().optional().describe(OPERATION_DESC), days: z.number().int().min(1).max(180).optional() },
      handler: (deps, user, i) => callMinerador(deps, user, "GET", `/api/dashboard/alerts-by-competitor${qs(i)}`),
    },
    {
      name: "alerts_by_category",
      description: "Quantos alertas de cada categoria nos últimos N dias.",
      shape: { operation: z.string().optional().describe(OPERATION_DESC), days: z.number().int().min(1).max(180).optional() },
      handler: (deps, user, i) => callMinerador(deps, user, "GET", `/api/dashboard/alerts-by-category${qs(i)}`),
    },
    {
      name: "new_products_timeline",
      description: "Quantos produtos novos surgiram por dia, num período.",
      shape: {
        competitorId: z.number().int().optional(),
        operation: z.string().optional().describe(OPERATION_DESC),
        days: z.number().int().min(1).max(360).optional(),
        startDate: z.string().optional().describe("AAAA-MM-DD."),
        endDate: z.string().optional().describe("AAAA-MM-DD."),
      },
      handler: (deps, user, i) => {
        const { competitorId, startDate, endDate, ...rest } = i;
        return callMinerador(
          deps,
          user,
          "GET",
          `/api/dashboard/new-products-timeline${qs({ ...rest, competitor_id: competitorId, start_date: startDate, end_date: endDate })}`,
        );
      },
    },
    {
      name: "ads_timeline",
      description: "Anúncios por dia, por plataforma (Meta/Google/TikTok), num período.",
      shape: {
        competitorId: z.number().int().optional(),
        operation: z.string().optional().describe(OPERATION_DESC),
        days: z.number().int().min(1).max(360).optional(),
        startDate: z.string().optional().describe("AAAA-MM-DD."),
        endDate: z.string().optional().describe("AAAA-MM-DD."),
      },
      handler: (deps, user, i) => {
        const { competitorId, startDate, endDate, ...rest } = i;
        return callMinerador(
          deps,
          user,
          "GET",
          `/api/dashboard/ads-timeline${qs({ ...rest, competitor_id: competitorId, start_date: startDate, end_date: endDate })}`,
        );
      },
    },
    {
      name: "score_distribution",
      description: "Quantos produtos ativos em cada faixa de score (Frio/Morno/Quente/Escalando) agora.",
      shape: { competitorId: z.number().int().optional(), operation: z.string().optional().describe(OPERATION_DESC) },
      handler: (deps, user, i) => {
        const { competitorId, ...rest } = i;
        return callMinerador(deps, user, "GET", `/api/dashboard/score-distribution${qs({ ...rest, competitor_id: competitorId })}`);
      },
    },

    // ───── Ecossistema ─────
    {
      name: "shared_vendors",
      description: "Fornecedores usados por 2 ou mais das suas lojas concorrentes rastreadas (pista de fornecedor confiável/popular no nicho).",
      shape: { minStores: z.number().int().min(2).optional().describe("Padrão: 2.") },
      handler: (deps, user, { minStores }) =>
        callMinerador(deps, user, "GET", `/api/ecosystem/shared-vendors${qs({ min_stores: minStores })}`),
    },

    // ───── Minerador de Anúncios (consulta avulsa) ─────
    {
      name: "create_ad_miner_scan",
      description: "Consulta avulsa de anúncios de uma URL/domínio, sem precisar cadastrar como concorrente. Roda em segundo plano — use get_ad_miner_scan pra ver o resultado.",
      shape: { url: z.string().describe("URL ou domínio da loja."), operation: z.string().describe(OPERATION_DESC) },
      handler: (deps, user, i) => callMinerador(deps, user, "POST", "/api/ad-miner/scans", i),
    },
    {
      name: "get_ad_miner_scan",
      description: "Resultado (ou status) de uma consulta avulsa do Minerador de Anúncios.",
      shape: { scanId: z.number().int() },
      handler: (deps, user, { scanId }) => callMinerador(deps, user, "GET", `/api/ad-miner/scans/${scanId}`),
    },

    // ───── Configurações ─────
    {
      name: "get_discord_webhook",
      description: "URL do webhook do Discord configurado pra receber alertas (ou null, se nenhum).",
      shape: {},
      handler: (deps, user) => callMinerador(deps, user, "GET", "/api/settings/discord"),
    },
    {
      name: "set_discord_webhook",
      description: "Configura o webhook do Discord pra receber alertas (recurso exclusivo do plano Pro).",
      shape: { url: z.string().url().describe("URL do webhook (https://discord.com/api/webhooks/...).") },
      handler: (deps, user, { url }) => callMinerador(deps, user, "PUT", "/api/settings/discord", { discord_webhook_url: url }),
    },
    {
      name: "remove_discord_webhook",
      description: "Remove o webhook do Discord configurado.",
      shape: {},
      handler: (deps, user) => callMinerador(deps, user, "DELETE", "/api/settings/discord"),
    },
    {
      name: "test_discord_webhook",
      description: "Envia uma mensagem de teste pro webhook do Discord já salvo.",
      shape: {},
      handler: (deps, user) => callMinerador(deps, user, "POST", "/api/settings/discord/test"),
    },
  ];
}

/** Monta um McpServer novo (uma instância por requisição, modo stateless) com todas as ferramentas. */
function createServer(deps, appUser) {
  const server = new McpServer({ name: "scoutx", version: "0.1.0" });
  for (const tool of buildTools()) {
    server.tool(tool.name, tool.description, tool.shape, async (args) => {
      try {
        const result = await tool.handler(deps, appUser, args || {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Erro: ${e.message}` }], isError: true };
      }
    });
  }
  return server;
}

/**
 * Monta o endpoint HTTP do MCP em `app` (Express), em /mcp/<SCOUTX_MCP_PATH_TOKEN>.
 * Sem as duas variáveis de ambiente, fica desligado (nada muda pro resto do app).
 */
function mountMcpServer(app, deps) {
  const PATH_TOKEN = process.env.SCOUTX_MCP_PATH_TOKEN;
  const USER_EMAIL = process.env.SCOUTX_MCP_USER_EMAIL;
  if (!PATH_TOKEN || !USER_EMAIL) {
    console.warn("[mcp] SCOUTX_MCP_PATH_TOKEN ou SCOUTX_MCP_USER_EMAIL não configurados — endpoint MCP desligado.");
    return;
  }

  app.all(`/mcp/${PATH_TOKEN}`, async (req, res) => {
    let appUser;
    try {
      appUser = await deps.db.findUserByEmail(USER_EMAIL);
    } catch (err) {
      console.error("[mcp] erro ao carregar o usuário do MCP:", err.message);
      return res.status(500).json({ error: "Não foi possível carregar o usuário do MCP." });
    }
    if (!appUser) {
      return res.status(500).json({ error: "SCOUTX_MCP_USER_EMAIL não corresponde a nenhum usuário." });
    }

    const server = createServer(deps, appUser);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] erro ao tratar requisição:", err.message);
      if (!res.headersSent) res.status(500).end();
    }
  });

  console.log(`[mcp] endpoint do ScoutX ligado em /mcp/<token>, agindo como ${USER_EMAIL}`);
}

module.exports = { mountMcpServer };
