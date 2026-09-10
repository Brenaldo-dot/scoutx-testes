// Sobe o ScoutX (web) LOCAL contra um Postgres real em memória (pg-mem), sem
// precisar de Docker/Postgres instalado na máquina — só pra revisão visual
// das telas novas (Indicação), não é ambiente de produção nem persiste nada
// entre reinícios. Roda o server.js/db.js DE VERDADE, sem reescrever a
// lógica: intercepta só o `require("pg")` pra devolver o Pool/Client
// fake do pg-mem em vez do driver real.
//
// Limitação conhecida (achada testando as queries de Indicação): pg-mem não
// reproduz certinho `ON CONFLICT ... DO NOTHING RETURNING` (devolve a linha
// conflitante em vez de vazio) — só afeta a idempotência de reenvio de
// webhook da Cakto, que não é testável aqui mesmo (não temos requisição real
// da Cakto local). Não afeta nada do que dá pra clicar na tela.
const Module = require("module");
const { newDb } = require("pg-mem");

const mem = newDb({ autoCreateForeignKeyIndices: true });
mem.public.registerFunction({ name: "now", returns: "timestamp", implementation: () => new Date() });
const fakePg = mem.adapters.createPg();

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "pg") return fakePg;
  return originalLoad.apply(this, arguments);
};

process.env.APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:3001";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "dev-local-only-session-secret-nao-usar-em-producao";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "dev-local-only-internal-secret";
process.env.CAKTO_WEBHOOK_SECRET = process.env.CAKTO_WEBHOOK_SECRET || "dev-local-only-cakto-secret";
// DATABASE_URL de propósito NÃO setada — db.js.ensureMineradorDatabase()
// pula inteiro quando não existe (ver db.js), o que é o certo aqui: pg-mem
// não suporta CREATE DATABASE/pg_database.
// MINERADOR_API_URL de propósito não setada — telas que dependem do FastAPI
// (Concorrentes, Produtos, etc.) vão dar erro de proxy se você navegar até
// elas, mas Indicação/Suporte/Minha Conta/Afiliados não precisam disso.

// NÃO usar `require("./server.js")` puro: o auto-start ali dentro só roda
// se `require.main === module` (rodando `node server.js` direto), o que
// nunca é verdade quando é OUTRO arquivo (este) que dá o require nele —
// então chama startServer() explicitamente aqui.
const { startServer } = require("./server.js");
startServer(process.env.PORT || 3001)
  .then(({ port }) => {
    console.log(`ScoutX (web) rodando em http://localhost:${port} — DEV LOCAL, pg-mem em memória, nada persiste.`);
  })
  .catch((err) => {
    console.error("Falha ao subir o ScoutX local:", err);
    process.exit(1);
  });
