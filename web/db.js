const { Pool, Client } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Planos de venda do ScoutX — 3 planos fixos, não precisa ser configurável
// pelo admin. maxOperations/maxCompetitors em Infinity = sem limite
// (Enterprise). Se um dia mudar preço/limite, é troca de constante aqui, não
// de schema. As CHAVES (solo/pro/agencia) são só o identificador interno,
// gravado em organizations.plan — não mudam com o rebrand dos nomes de
// venda (Solo → Standard, Pro → Pro, Agência → Enterprise), só o "label"
// exibido pra pessoa muda.
//
// maxUsers é sempre 1 nos três planos — decisão de negócio: cada conta é de
// UMA equipe (1 login), não de N colaboradores dividindo uma assinatura;
// o que muda de plano pra plano é só o número de países/concorrentes.
// Fixo em 1 (não uma constante à parte) de propósito, pra não sobrar
// nenhuma trilha de "plano X permite N usuários" pra reintroduzir sem querer.
const PLAN_LIMITS = {
  solo: { label: "Standard", maxUsers: 1, maxOperations: 1, maxCompetitors: 50 },
  pro: { label: "Pro", maxUsers: 1, maxOperations: 3, maxCompetitors: 250 },
  agencia: { label: "Enterprise", maxUsers: 1, maxOperations: Infinity, maxCompetitors: Infinity },
};
const BILLING_CYCLE_DAYS = { mensal: 30, trimestral: 90, anual: 365 };

// O backend Python do Mega Minerador precisa do próprio banco, separado das
// tabelas deste app. Em vez de pedir pra alguém criar isso manualmente no
// mesmo servidor Postgres, criamos aqui no boot (idempotente — não faz nada
// se já existir). MINERADOR_DB_NAME é só o nome lógico do banco; a URL final
// pros serviços Python é a mesma do Postgres trocando o nome do banco no fim.
const MINERADOR_DB_NAME = "minerador_intel";

async function ensureMineradorDatabase() {
  if (!process.env.DATABASE_URL) return;
  const exists = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [MINERADOR_DB_NAME]);
  if (exists.rows.length > 0) return;

  // CREATE DATABASE não pode rodar dentro de uma transação nem via pool
  // (o driver às vezes agrupa em transação implícita) — usamos um Client
  // solto, direto.
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${MINERADOR_DB_NAME}`);
    console.log(`Banco "${MINERADOR_DB_NAME}" criado para o Mega Minerador.`);
  } catch (err) {
    if (err.code !== "42P04") throw err; // 42P04 = database already exists (corrida com outro boot)
  } finally {
    await client.end();
  }
}

async function migrate() {
  // A tabela anterior guardava usuários pelo login OAuth do pm-board (schema
  // diferente, sem email/senha). Trocamos pra login próprio — como ainda não
  // tinha nenhum usuário real usando aquele fluxo, recriamos do zero.
  const hasOldSchema = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'app_users' AND column_name = 'pmboard_user_id'
  `);
  if (hasOldSchema.rows.length > 0) {
    await pool.query("DROP TABLE IF EXISTS search_logs");
    await pool.query("DROP TABLE IF EXISTS app_users");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'collaborator',
      can_view_history BOOLEAN NOT NULL DEFAULT false,
      can_access_minerador BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS can_access_minerador BOOLEAN NOT NULL DEFAULT false;`);
  // Bloqueio de login escalonado (revisão de segurança) — ver
  // failedLoginAttempt/checkLoginLock em server.js.
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;`);
  // Revisão de segurança: sessão hoje é só um cookie assinado com validade
  // de 30 dias, sem nenhuma lista de revogação — trocar a senha não
  // invalidava sessões já abertas em outro lugar (nem uma sessão roubada).
  // token_version vai dentro do cookie no login (auth.js/setSessionCookie);
  // toda troca de senha incrementa esse número (updateUserPassword, abaixo)
  // — qualquer cookie assinado com o número antigo passa a ser rejeitado
  // (requireAuth), mesmo com assinatura válida e prazo não vencido.
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;`);
  // Suspensão reversível — diferente de excluir: bloqueia login na hora
  // (checado em /login) sem apagar histórico/permissões, útil pra investigar
  // algo suspeito sem perder o usuário. role_changed_by_id/at é auditoria de
  // quem promoveu/rebaixou quem admin — dar admin é a ação mais sensível da
  // tela e antes disso não ficava registrado em lugar nenhum.
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false;`);
  // Foto de perfil (Minha Conta) — guardada como data URI já redimensionada
  // no navegador (~256px, JPEG) antes de subir, então cabe tranquilo num
  // TEXT do Postgres sem precisar de storage de arquivo (S3 etc.) só pra
  // isso. TEXT sem limite de tamanho fixo — o teto de verdade é aplicado no
  // PATCH /api/me/avatar (server.js), não aqui.
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS role_changed_by_id INTEGER;`);
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS role_changed_at TIMESTAMPTZ;`);
  // Conta criada pelo webhook da Cakto nasce com uma senha aleatória que
  // NINGUÉM sabe (nem a gente guarda em lugar nenhum) — essa flag marca
  // que ela ainda precisa passar por /registrar (a pessoa prova que é dona
  // da compra digitando o mesmo email, e escolhe a própria senha ali,
  // ver POST /registrar em server.js). Evita depender de correlacionar um
  // refId entre o redirect da Cakto e o webhook, que na prática não bateu
  // certo no teste real (ver HANDOFF.md).
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS needs_password_setup BOOLEAN NOT NULL DEFAULT false;`);
  // "Última vez visto" (pedido do admin, 2026-08-31) — diferente de
  // last_login_at (login_events, só marca QUANDO logou): essa coluna
  // acompanha uso de verdade, atualizada a cada request autenticada. Pra
  // não pesar o app com um UPDATE em TODA requisição, requireAuth
  // (server.js) só escreve se fizer mais de 5 minutos desde o valor já
  // carregado em memória — na prática um UPDATE bem esparso por usuário
  // ativo, não por request.
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS search_logs (
      id SERIAL PRIMARY KEY,
      app_user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      domain TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_search_logs_user ON search_logs(app_user_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_events (
      id SERIAL PRIMARY KEY,
      app_user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      ip TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(app_user_id);`);

  // Log de auditoria administrativa — pedido do usuário pra rastrear quem
  // fez o quê entre vários admins (promoveu, suspendeu, resetou senha,
  // excluiu). actor/target_name são um SNAPSHOT do nome no momento da ação
  // (não FK) de propósito: um usuário excluído não pode deixar o log
  // ilegível ("Usuário #47 excluiu Usuário #52") só porque uma das duas
  // pontas sumiu depois.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      actor_id INTEGER,
      actor_name TEXT NOT NULL,
      target_id INTEGER,
      target_name TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log(created_at DESC);`);

  // Programa de afiliados feito por dentro do app (2026-08-31) — a Cakto só
  // suporta UMA comissão fixa por produto, não uma taxa pra primeira venda e
  // outra pra recorrência (achado ao vivo, conferido no painel dela). O link
  // de afiliado em si continua sendo o da Cakto (é ela quem rastreia clique/
  // cookie); a gente só usa a API deles (ver caktoApi.js) pra descobrir QUEM
  // é o afiliado de cada pedido (campo commissions[].type === "affiliate"),
  // casando pelo email, e calculamos/guardamos a comissão com as NOSSAS
  // taxas aqui.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS affiliates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      cakto_email TEXT NOT NULL UNIQUE,
      pix_key TEXT,
      first_sale_percentage NUMERIC(5,2) NOT NULL,
      recurring_percentage NUMERIC(5,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Uma linha por comissão gerada (1ª venda de um cliente novo, ou cada
  // renovação depois) — cakto_order_id é o `data.id` do webhook/API da
  // Cakto, UNIQUE pra nunca gerar comissão em dobro se o mesmo evento vier
  // de novo (Cakto reenvia webhook em caso de timeout, ver cakto.js).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS affiliate_commissions (
      id SERIAL PRIMARY KEY,
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      cakto_order_id TEXT NOT NULL UNIQUE,
      customer_email TEXT NOT NULL,
      customer_name TEXT,
      sale_amount NUMERIC(10,2) NOT NULL,
      commission_type TEXT NOT NULL, -- 'first_sale' | 'recurring'
      commission_percentage NUMERIC(5,2) NOT NULL,
      commission_value NUMERIC(10,2) NOT NULL,
      paid BOOLEAN NOT NULL DEFAULT false,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_affiliate ON affiliate_commissions(affiliate_id);`);

  // Indicação (2026-09-10) — programa separado do de afiliados acima:
  // aqui é o PRÓPRIO CLIENTE que pede o cupom (self-service, dentro do
  // app), não um afiliado externo cadastrado manualmente pelo admin. Cada
  // app_user só pode ter UM cupom na vida (UNIQUE em user_id) — pedir de
  // novo com um já existente só devolve o que já tem, ver
  // createReferralCouponRequest. `coupon_code` fica null enquanto
  // "requested": o cupom em si é criado à mão no painel da Cakto (não tem
  // API pública pra isso, conferido na doc oficial) e o admin cola o
  // código aqui pra ativar.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_coupons (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
      coupon_code TEXT UNIQUE,
      pix_key TEXT,
      whatsapp TEXT,
      status TEXT NOT NULL DEFAULT 'requested', -- 'requested' | 'active' | 'disabled'
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      activated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Uma linha por venda em que o couponCode da compra bateu com um cupom de
  // indicação ativo — sempre comissão de "primeira venda" (decisão do
  // usuário: só a compra inicial do indicado gera comissão, não
  // renovações). Mesma idempotência/estorno que affiliate_commissions
  // acima (cakto_order_id UNIQUE, apagada em reembolso/chargeback).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_commissions (
      id SERIAL PRIMARY KEY,
      referral_coupon_id INTEGER NOT NULL REFERENCES referral_coupons(id) ON DELETE CASCADE,
      cakto_order_id TEXT NOT NULL UNIQUE,
      customer_email TEXT NOT NULL,
      customer_name TEXT,
      sale_amount NUMERIC(10,2) NOT NULL,
      commission_percentage NUMERIC(5,2) NOT NULL,
      commission_value NUMERIC(10,2) NOT NULL,
      paid BOOLEAN NOT NULL DEFAULT false,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_referral_commissions_coupon ON referral_commissions(referral_coupon_id);`);

  // Planos de venda — cada organização agrupa N logins (app_users) sob um
  // plano/ciclo/validade só. expires_at vencido bloqueia login de TODO
  // mundo da organização (checado em requireAuth/login, ver server.js).
  // notes é texto livre do admin (valor pago, canal de venda) — sem campo
  // estruturado de preço nessa fase (ativação ainda é manual).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT NOT NULL,
      billing_cycle TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);`);

  // País/operação que a conta escolheu na primeira vez que abriu o app —
  // até aqui isso só vivia no localStorage do NAVEGADOR (ver
  // OperationContext.jsx no React), então trocar de dispositivo/navegador,
  // ou até só limpar os dados do site, fazia perguntar de novo pra sempre.
  // NULL = essa organização ainda nunca escolheu (mostra o seletor
  // inicial); depois de escolhida uma vez, fica valendo pra sempre, mesmo
  // trocando de plano — não é a mesma coisa que "qual país está sendo
  // visto agora" (isso continua livre, ver seletor no menu lateral).
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_operation TEXT;`);

  // Automação Cakto: cakto_purchase_id/cakto_customer_email identificam qual
  // organização veio de qual compra, pra um evento de cancelamento/reembolso
  // futuro (que só traz o ID da compra ou o email do comprador) achar a
  // organização certa pra suspender. NULL pras organizações criadas
  // manualmente pelo admin (a maioria hoje).
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cakto_purchase_id TEXT;`);
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cakto_customer_email TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_organizations_cakto_purchase ON organizations(cakto_purchase_id) WHERE cakto_purchase_id IS NOT NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_organizations_cakto_email ON organizations(cakto_customer_email) WHERE cakto_customer_email IS NOT NULL;`);

  // Idempotência do webhook: a Cakto pode reenviar o mesmo evento (timeout,
  // retry automático dela) — sem isso, um reenvio de "purchase_approved"
  // criaria uma segunda organização/usuário pra mesma compra. Chave composta
  // (id da compra + evento) porque a MESMA compra gera vários eventos ao
  // longo do tempo (aprovada, depois talvez reembolsada).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cakto_events (
      purchase_id TEXT NOT NULL,
      event TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received',
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (purchase_id, event)
    );
  `);

  // Backfill: todo usuário collaborator que já existia antes dessa revisão
  // (e qualquer um sem organização por algum motivo) recebe uma organização
  // própria de "Legado", plano Enterprise (sem limite) e validade 10 anos no
  // futuro — ninguém trava no dia desse deploy. O admin reorganiza quem
  // realmente compartilha uma assinatura só depois, pela tela de
  // Organizações. Contas admin (role='admin') nunca recebem organização —
  // seguem sem limite, é o modelo delas hoje.
  const orphaned = await pool.query(
    "SELECT id, name FROM app_users WHERE organization_id IS NULL AND role != 'admin'"
  );
  for (const user of orphaned.rows) {
    const org = await pool.query(
      `INSERT INTO organizations (name, plan, billing_cycle, expires_at, notes)
       VALUES ($1, 'agencia', 'anual', now() + interval '10 years', 'Criada automaticamente na migração de planos — reorganizar se necessário')
       RETURNING id`,
      [`Legado — ${user.name}`]
    );
    await pool.query("UPDATE app_users SET organization_id = $1 WHERE id = $2", [org.rows[0].id, user.id]);
  }

  // Comunidade de embaixadores (2026-09-10) — extensão do programa de
  // afiliados acima: cada afiliado pode virar "dono" de uma comunidade
  // fechada. Fica ligada em `affiliates`, não em `app_users`, porque quem
  // já existe como afiliado hoje não tem login nenhum no ScoutX — quando a
  // pessoa loga, a gente reconhece que ela é embaixadora comparando o email
  // dela com `affiliates.cakto_email` (mesmo truque que
  // recordAffiliateCommissionIfAny em cakto.js já usa), sem precisar de
  // coluna nova de vínculo.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS communities (
      id SERIAL PRIMARY KEY,
      affiliate_id INTEGER NOT NULL UNIQUE REFERENCES affiliates(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      photo_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // organization_id UNIQUE: uma organização só entra em UMA comunidade pra
  // sempre (decisão do usuário — não é possível trocar de comunidade,
  // mesmo cancelando e reativando a assinatura depois, já que a
  // organização não é recriada numa renovação).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_members (
      id SERIAL PRIMARY KEY,
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_community_members_community ON community_members(community_id);`);

  // Canais (2026-09-10, pedido do usuário pra parecer mais um fórum de
  // verdade tipo Circle/Skool): uma comunidade tem N canais, só o
  // embaixador dono cria/remove. `position` decide a ordem exibida na
  // barra lateral — sempre inserido no fim (MAX(position)+1), sem
  // reordenação por enquanto.
  // group_name (2026-09-11): agrupa canais em seções com cabeçalho na
  // barra lateral (tipo "TOP Fornecedores" reunindo vários canais na
  // referência que o usuário mandou) — null cai num grupo "Canais" genérico
  // no front. Não é uma tabela própria de propósito: só um rótulo de texto
  // livre, mais simples que modelar categoria como entidade separada.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_channels (
      id SERIAL PRIMARY KEY,
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      group_name TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_community_channels_community ON community_channels(community_id);`);

  // community_id fica denormalizado aqui (além de channel_id) de propósito
  // — mesmo padrão de snapshot já usado em outras tabelas deste arquivo:
  // deixa consultas que só precisam "todos os posts da comunidade" (sem
  // se importar com canal) simples, sem JOIN extra. `pinned` fixa o post
  // no topo do canal (embaixador decide, tipo o post "Como funciona" fixado
  // na referência que o usuário mandou).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id SERIAL PRIMARY KEY,
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES community_channels(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      image_url TEXT,
      pinned BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_community_posts_community ON community_posts(community_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_community_posts_channel ON community_posts(channel_id);`);

  // Curtida: par (post, quem curtiu) único — clicar de novo tira a
  // curtida (toggle), não acumula.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_post_likes (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (post_id, user_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_community_post_likes_post ON community_post_likes(post_id);`);

  // author_user_id cobre TANTO membro comum QUANTO o próprio embaixador
  // (ele também loga como app_user normal, ver comentário em `communities`
  // acima) — is_ambassador só marca visualmente quem respondeu como dono
  // da comunidade. author_name é um SNAPSHOT (mesmo padrão de
  // admin_audit_log): comentário antigo continua legível mesmo se a conta
  // for excluída depois.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      author_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
      author_name TEXT NOT NULL,
      is_ambassador BOOLEAN NOT NULL DEFAULT false,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_community_comments_post ON community_comments(post_id);`);

  // Uma linha por renovação de QUALQUER membro ativo da comunidade —
  // calculada no momento do webhook (ver cakto.js:
  // recordCommunityCommissionIfAny), nunca por um job agendado. Guarda
  // member_count_at_time/tier pra auditoria (se o admin questionar por que
  // uma comissão saiu com % X, dá pra ver exatamente quantos membros
  // ativos a comunidade tinha naquele instante).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_commissions (
      id SERIAL PRIMARY KEY,
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      cakto_order_id TEXT NOT NULL UNIQUE,
      customer_email TEXT NOT NULL,
      customer_name TEXT,
      sale_amount NUMERIC(10,2) NOT NULL,
      member_count_at_time INTEGER NOT NULL,
      tier TEXT NOT NULL,
      commission_percentage NUMERIC(5,2) NOT NULL,
      commission_value NUMERIC(10,2) NOT NULL,
      paid BOOLEAN NOT NULL DEFAULT false,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_community_commissions_community ON community_commissions(community_id);`);
}

// Só grava se ainda não tinha nada (NULL) — a primeira escolha da conta
// vale pra sempre, tentar chamar de novo depois não sobrescreve (evita uma
// chamada maliciosa/acidental de outro dispositivo "resetando" o país já
// decidido). Devolve a organização atualizada, com o valor que realmente
// ficou valendo (pode não ser o `value` passado, se já tinha outro antes).
async function setOrgDefaultOperationIfUnset(organizationId, value) {
  const res = await pool.query(
    `UPDATE organizations SET default_operation = $1 WHERE id = $2 AND default_operation IS NULL RETURNING *`,
    [value, organizationId]
  );
  if (res.rows[0]) return res.rows[0];
  return await getOrganizationById(organizationId);
}

// Sobrescreve incondicionalmente (ao contrário da versão acima, que só
// grava se ainda for NULL) — usado quando a pessoa EXCLUI o país que era o
// padrão da conta (ver removeOperation em OperationContext.jsx): sem isso,
// o valor antigo (já apagado da lista local) voltava sozinho a cada
// refresh/dispositivo novo, porque o servidor continuava devolvendo ele em
// GET /api/me. value null limpa de vez (conta sem nenhum país mais).
async function setOrgDefaultOperation(organizationId, value) {
  const res = await pool.query(`UPDATE organizations SET default_operation = $1 WHERE id = $2 RETURNING *`, [
    value,
    organizationId,
  ]);
  return res.rows[0];
}

async function countUsers() {
  const res = await pool.query("SELECT COUNT(*)::int AS n FROM app_users");
  return res.rows[0].n;
}

// Admin suspenso não conta — senão "o último admin ATIVO" ficaria escondido
// atrás de um admin que já nem consegue logar, e a trava deixaria de
// proteger contra o cenário real (ninguém com acesso de fato).
async function countActiveAdmins() {
  const res = await pool.query("SELECT COUNT(*)::int AS n FROM app_users WHERE role = 'admin' AND suspended = false");
  return res.rows[0].n;
}

async function createUser({ name, email, passwordHash, role, createdById, organizationId, needsPasswordSetup }) {
  const isAdmin = role === "admin";
  // Colaborador preso a uma organização é cliente pagante — ScoutX é o
  // PRÓPRIO produto vendido, não faz sentido nascer sem acesso a ele e
  // depender do admin lembrar de destravar depois manualmente (bug real:
  // usuário do plano Standard criado sem conseguir nem ver o app até alguém
  // notar e mexer no toggle). Admin continua sem esse campo fazer sentido
  // (já tem acesso total por ser admin).
  const canAccessMinerador = !isAdmin && !!organizationId;
  const res = await pool.query(
    `INSERT INTO app_users (name, email, password_hash, role, role_changed_by_id, role_changed_at, organization_id, can_access_minerador, needs_password_setup)
     VALUES ($1, $2, $3, $4, $5, ${isAdmin ? "now()" : "NULL"}, $6, $7, $8) RETURNING *`,
    [
      name,
      email.toLowerCase().trim(),
      passwordHash,
      role || "collaborator",
      isAdmin ? createdById || null : null,
      isAdmin ? null : organizationId || null,
      canAccessMinerador,
      !!needsPasswordSetup,
    ]
  );
  return res.rows[0];
}

// Usado só por POST /registrar (server.js) — a pessoa prova que é dona da
// compra digitando o mesmo email que usou na Cakto, escolhe a própria
// senha, e essa flag nunca mais volta a true pra essa conta.
async function completePasswordSetup(id, passwordHash) {
  const res = await pool.query(
    `UPDATE app_users SET password_hash = $1, needs_password_setup = false,
       failed_login_attempts = 0, locked_until = NULL, token_version = token_version + 1
     WHERE id = $2 RETURNING *`,
    [passwordHash, id]
  );
  return res.rows[0];
}

// org_plan/org_expires_at vêm junto (LEFT JOIN) porque requireAuth e /login
// checam o vencimento do plano a cada request — sem isso seria uma query a
// mais em todo request autenticado só pra saber se o plano venceu.
const USER_WITH_ORG_SELECT = `
  SELECT u.*, o.plan AS org_plan, o.expires_at AS org_expires_at, o.name AS org_name,
         o.default_operation AS org_default_operation
  FROM app_users u
  LEFT JOIN organizations o ON o.id = u.organization_id
`;

async function findUserByEmail(email) {
  const res = await pool.query(`${USER_WITH_ORG_SELECT} WHERE u.email = $1`, [email.toLowerCase().trim()]);
  return res.rows[0] || null;
}

// Fire-and-forget de propósito (ver requireAuth em server.js — chamado sem
// await, com .catch silencioso) — atualizar "última vez visto" nunca deve
// atrasar nem quebrar a requisição real da pessoa.
async function touchLastSeen(userId) {
  await pool.query("UPDATE app_users SET last_seen_at = now() WHERE id = $1", [userId]);
}

async function getAppUserById(id) {
  const res = await pool.query(`${USER_WITH_ORG_SELECT} WHERE u.id = $1`, [id]);
  return res.rows[0] || null;
}

async function listUsersWithCounts() {
  // all_ips/last_login_at: admin pedia pra ver QUAL IP, não só "⚠️ N IPs" —
  // manda a lista inteira de uma vez (tabela de admin é pequena, não compensa
  // 1 request por usuário só pra popular isso na tela principal).
  const res = await pool.query(`
    SELECT u.id, u.name, u.email, u.role, u.can_access_minerador, u.created_at,
           u.failed_login_attempts, u.locked_until, u.suspended, u.role_changed_at, u.last_seen_at,
           u.organization_id, o.name AS organization_name, o.plan AS organization_plan,
           o.expires_at AS organization_expires_at,
           (SELECT c.name FROM app_users c WHERE c.id = u.role_changed_by_id) AS role_changed_by_name,
           COUNT(DISTINCT s.id)::int AS search_count,
           COUNT(DISTINCT l.ip)::int AS ip_count,
           (
             SELECT le.ip FROM login_events le
             WHERE le.app_user_id = u.id
             ORDER BY le.created_at DESC
             LIMIT 1
           ) AS last_ip,
           (
             SELECT le.created_at FROM login_events le
             WHERE le.app_user_id = u.id
             ORDER BY le.created_at DESC
             LIMIT 1
           ) AS last_login_at,
           (
             SELECT array_agg(DISTINCT le.ip) FROM login_events le WHERE le.app_user_id = u.id
           ) AS all_ips
    FROM app_users u
    LEFT JOIN search_logs s ON s.app_user_id = u.id
    LEFT JOIN login_events l ON l.app_user_id = u.id
    LEFT JOIN organizations o ON o.id = u.organization_id
    GROUP BY u.id, o.name, o.plan, o.expires_at
    ORDER BY u.created_at ASC
  `);
  return res.rows;
}

async function logLogin(appUserId, ip) {
  await pool.query("INSERT INTO login_events (app_user_id, ip) VALUES ($1, $2)", [appUserId, ip || "desconhecido"]);
}

async function ipSummaryForUser(appUserId) {
  const res = await pool.query(
    `SELECT ip, COUNT(*)::int AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
     FROM login_events
     WHERE app_user_id = $1
     GROUP BY ip
     ORDER BY last_at DESC`,
    [appUserId]
  );
  return res.rows;
}

async function updateUserPermissions(id, { role, canAccessMinerador, suspended, changedById, organizationId }) {
  const fields = [];
  const values = [];
  let i = 1;
  if (role !== undefined) {
    fields.push(`role = $${i++}`);
    values.push(role);
    // Auditoria: quem promoveu/rebaixou quem, e quando — mostrado na tabela
    // de Usuários pro admin saber depois "quem deu admin pra fulano".
    fields.push(`role_changed_by_id = $${i++}`);
    values.push(changedById || null);
    fields.push(`role_changed_at = now()`);
  }
  // organizationId: null explícito tira o usuário de qualquer organização
  // (admin não pertence a nenhuma) — undefined significa "não mexer nisso".
  // A checagem de limite de usuários do plano/organização de destino já foi
  // feita antes de chamar isto, em server.js (mesma regra do POST /api/admin/users).
  if (organizationId !== undefined) {
    fields.push(`organization_id = $${i++}`);
    values.push(organizationId);
  }
  if (canAccessMinerador !== undefined) {
    fields.push(`can_access_minerador = $${i++}`);
    values.push(canAccessMinerador);
  }
  if (suspended !== undefined) {
    fields.push(`suspended = $${i++}`);
    values.push(suspended);
    if (suspended) {
      // Mesmo mecanismo da troca de senha: mata qualquer sessão já aberta
      // na hora, senão o cookie já emitido (válido por até 30 dias) seguiria
      // funcionando normalmente apesar da suspensão.
      fields.push(`token_version = token_version + 1`);
    }
  }
  if (fields.length === 0) return;
  values.push(id);
  await pool.query(`UPDATE app_users SET ${fields.join(", ")} WHERE id = $${i}`, values);
}

// Bloqueio de login escalonado — pedido explícito do usuário, 3 níveis:
// 3 erros seguidos → 5 min de bloqueio; +2 erros (5 no total) → 10 min;
// +1 erro (6 no total) → bloqueado até um admin redefinir a senha (sem
// fluxo de email — decisão junto com o usuário, ver conversa). O contador só
// avança quando a pessoa TENTA de verdade (login.js só chama isso fora de
// um bloqueio ativo), então "+2 tentativas" e "+1 tentativa" são exatamente
// as tentativas que sobram depois de cada bloqueio expirar.
const LOGIN_LOCK_TIERS = [
  { attempts: 6, minutes: null }, // null = bloqueio permanente (até reset de senha)
  { attempts: 5, minutes: 10 },
  { attempts: 3, minutes: 5 },
];

async function recordFailedLogin(userId) {
  const res = await pool.query(
    "UPDATE app_users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = $1 RETURNING failed_login_attempts",
    [userId]
  );
  const attempts = res.rows[0].failed_login_attempts;
  const tier = LOGIN_LOCK_TIERS.find((t) => attempts === t.attempts || (t.minutes === null && attempts >= t.attempts));
  if (!tier) return { attempts, lockedUntil: null, permanent: false };

  const permanent = tier.minutes === null;
  // "Permanente" = trava bem longe no futuro — updateUserPassword (reset de
  // admin ou autoatendimento) é o único jeito de zerar isso de verdade.
  const lockedUntil = permanent ? new Date("9999-01-01T00:00:00Z") : new Date(Date.now() + tier.minutes * 60 * 1000);
  await pool.query("UPDATE app_users SET locked_until = $1 WHERE id = $2", [lockedUntil, userId]);
  return { attempts, lockedUntil, permanent };
}

async function resetFailedLogins(userId) {
  await pool.query("UPDATE app_users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1", [userId]);
}

async function updateUserPassword(id, passwordHash) {
  // Redefinir a senha (admin OU a própria pessoa) sempre destrava a conta —
  // é o "escape hatch" do bloqueio permanente, ver LOGIN_LOCK_TIERS acima.
  // token_version +1 invalida toda sessão aberta em outro lugar (ou
  // roubada) na hora — ver nota em migrate() sobre isso. Devolve a versão
  // nova pra quem chamou poder emitir um cookie novo válido pra sessão
  // ATUAL (autoatendimento não pode deslogar a própria pessoa que acabou
  // de trocar a senha com sucesso).
  const res = await pool.query(
    "UPDATE app_users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL, token_version = token_version + 1 WHERE id = $2 RETURNING token_version",
    [passwordHash, id]
  );
  return res.rows[0].token_version;
}

async function deleteUser(id) {
  await pool.query("DELETE FROM app_users WHERE id = $1", [id]);
}

async function updateUserAvatar(id, avatarUrl) {
  const res = await pool.query("UPDATE app_users SET avatar_url = $1 WHERE id = $2 RETURNING avatar_url", [
    avatarUrl,
    id,
  ]);
  return res.rows[0]?.avatar_url ?? null;
}

async function updateUserName(id, name) {
  const res = await pool.query("UPDATE app_users SET name = $1 WHERE id = $2 RETURNING name", [name, id]);
  return res.rows[0]?.name ?? null;
}

async function logSearch(appUserId, tool, domain, url) {
  await pool.query("INSERT INTO search_logs (app_user_id, tool, domain, url) VALUES ($1, $2, $3, $4)", [
    appUserId,
    tool,
    domain,
    url,
  ]);
}

async function logAdminAction(actorId, actorName, targetId, targetName, action, details) {
  await pool.query(
    "INSERT INTO admin_audit_log (actor_id, actor_name, target_id, target_name, action, details) VALUES ($1, $2, $3, $4, $5, $6)",
    [actorId, actorName, targetId, targetName, action, details || null]
  );
}

async function listAdminAuditLog(limit = 100) {
  const res = await pool.query("SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT $1", [limit]);
  return res.rows;
}

// ---------- Afiliados ----------

async function listAffiliates() {
  const res = await pool.query("SELECT * FROM affiliates ORDER BY created_at DESC");
  return res.rows;
}

async function findAffiliateByCaktoEmail(email) {
  const res = await pool.query("SELECT * FROM affiliates WHERE cakto_email = $1", [email.toLowerCase().trim()]);
  return res.rows[0] || null;
}

async function createAffiliate({ name, caktoEmail, pixKey, firstSalePercentage, recurringPercentage }) {
  const res = await pool.query(
    `INSERT INTO affiliates (name, cakto_email, pix_key, first_sale_percentage, recurring_percentage)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, caktoEmail.toLowerCase().trim(), pixKey || null, firstSalePercentage, recurringPercentage]
  );
  return res.rows[0];
}

async function deleteAffiliate(id) {
  await pool.query("DELETE FROM affiliates WHERE id = $1", [id]);
}

// ON CONFLICT DO NOTHING (cakto_order_id é UNIQUE): idempotente de propósito
// — se o mesmo evento de webhook chegar de novo (reenvio da Cakto por
// timeout, ver cakto.js), não gera comissão em dobro pro mesmo pedido.
// Devolve null quando já existia (nada foi inserido), pra quem chama saber
// que não precisa notificar de novo.
async function createAffiliateCommission({
  affiliateId,
  caktoOrderId,
  customerEmail,
  customerName,
  saleAmount,
  commissionType,
  commissionPercentage,
  commissionValue,
}) {
  const res = await pool.query(
    `INSERT INTO affiliate_commissions
       (affiliate_id, cakto_order_id, customer_email, customer_name, sale_amount, commission_type, commission_percentage, commission_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (cakto_order_id) DO NOTHING
     RETURNING *`,
    [affiliateId, caktoOrderId, customerEmail, customerName || null, saleAmount, commissionType, commissionPercentage, commissionValue]
  );
  return res.rows[0] || null;
}

async function listAffiliateCommissions() {
  const res = await pool.query(`
    SELECT c.*, a.name AS affiliate_name, a.cakto_email AS affiliate_email, a.pix_key AS affiliate_pix_key
    FROM affiliate_commissions c
    JOIN affiliates a ON a.id = c.affiliate_id
    ORDER BY c.created_at DESC
  `);
  return res.rows;
}

async function markAffiliateCommissionPaid(id, paid) {
  const res = await pool.query(
    "UPDATE affiliate_commissions SET paid = $1, paid_at = CASE WHEN $1 THEN now() ELSE NULL END WHERE id = $2 RETURNING *",
    [paid, id]
  );
  return res.rows[0] || null;
}

// Chamado em reembolso/chargeback/cancelamento (ver cakto.js:
// handleCancellationEvent) — pedido do usuário: uma comissão nunca pode
// aparecer "a pagar" pra uma venda que acabou não se confirmando. Se ainda
// não foi paga, apaga na hora (nunca chega a aparecer pro admin). Se JÁ
// tinha sido paga (afiliado recebeu antes do cliente cancelar), não dá pra
// desfazer sozinho — devolve a linha pra quem chamar decidir o que avisar.
async function voidAffiliateCommission(caktoOrderId) {
  const existing = await pool.query("SELECT * FROM affiliate_commissions WHERE cakto_order_id = $1", [caktoOrderId]);
  const commission = existing.rows[0];
  if (!commission) return null;
  if (commission.paid) return commission;
  await pool.query("DELETE FROM affiliate_commissions WHERE id = $1", [commission.id]);
  return commission;
}

// ---------- Indicação (cupom de cliente) ----------

async function getReferralCouponByUserId(userId) {
  const res = await pool.query("SELECT * FROM referral_coupons WHERE user_id = $1", [userId]);
  return res.rows[0] || null;
}

async function findReferralCouponByCode(code) {
  const res = await pool.query("SELECT * FROM referral_coupons WHERE coupon_code = $1 AND status = 'active'", [
    String(code).trim(),
  ]);
  return res.rows[0] || null;
}

// Idempotente de propósito (ON CONFLICT DO NOTHING + SELECT de volta): se a
// pessoa clicar "Solicitar cupom" de novo (recarregou a página, clicou 2x),
// não cria uma segunda linha nem apaga o pix_key que já tinha preenchido —
// só devolve o pedido que já existe.
async function createReferralCouponRequest(userId, pixKey, whatsapp) {
  await pool.query(
    `INSERT INTO referral_coupons (user_id, pix_key, whatsapp) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
    [userId, pixKey || null, whatsapp || null]
  );
  return getReferralCouponByUserId(userId);
}

async function updateReferralCouponPix(userId, pixKey) {
  const res = await pool.query("UPDATE referral_coupons SET pix_key = $1 WHERE user_id = $2 RETURNING *", [
    pixKey || null,
    userId,
  ]);
  return res.rows[0] || null;
}

async function updateReferralCouponWhatsapp(userId, whatsapp) {
  const res = await pool.query("UPDATE referral_coupons SET whatsapp = $1 WHERE user_id = $2 RETURNING *", [
    whatsapp || null,
    userId,
  ]);
  return res.rows[0] || null;
}

async function listReferralCoupons() {
  const res = await pool.query(`
    SELECT rc.*, u.name AS user_name, u.email AS user_email
    FROM referral_coupons rc
    JOIN app_users u ON u.id = rc.user_id
    ORDER BY rc.requested_at DESC
  `);
  return res.rows;
}

// Admin cola o código criado manualmente no painel da Cakto — é isso que
// libera o cupom pra pessoa ver/compartilhar (ver POST
// /api/admin/referrals/:id/activate em server.js).
async function activateReferralCoupon(id, couponCode) {
  const res = await pool.query(
    `UPDATE referral_coupons SET coupon_code = $1, status = 'active', activated_at = now() WHERE id = $2 RETURNING *`,
    [String(couponCode).trim(), id]
  );
  return res.rows[0] || null;
}

async function createReferralCommission({
  referralCouponId,
  caktoOrderId,
  customerEmail,
  customerName,
  saleAmount,
  commissionPercentage,
  commissionValue,
}) {
  const res = await pool.query(
    `INSERT INTO referral_commissions
       (referral_coupon_id, cakto_order_id, customer_email, customer_name, sale_amount, commission_percentage, commission_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (cakto_order_id) DO NOTHING
     RETURNING *`,
    [referralCouponId, caktoOrderId, customerEmail, customerName || null, saleAmount, commissionPercentage, commissionValue]
  );
  return res.rows[0] || null;
}

async function listReferralCommissionsByUserId(userId) {
  const res = await pool.query(
    `SELECT rc.* FROM referral_commissions rc
     JOIN referral_coupons c ON c.id = rc.referral_coupon_id
     WHERE c.user_id = $1
     ORDER BY rc.created_at DESC`,
    [userId]
  );
  return res.rows;
}

async function listReferralCommissions() {
  const res = await pool.query(`
    SELECT rc.*, c.coupon_code, c.pix_key, u.name AS referrer_name, u.email AS referrer_email
    FROM referral_commissions rc
    JOIN referral_coupons c ON c.id = rc.referral_coupon_id
    JOIN app_users u ON u.id = c.user_id
    ORDER BY rc.created_at DESC
  `);
  return res.rows;
}

async function markReferralCommissionPaid(id, paid) {
  const res = await pool.query(
    "UPDATE referral_commissions SET paid = $1, paid_at = CASE WHEN $1 THEN now() ELSE NULL END WHERE id = $2 RETURNING *",
    [paid, id]
  );
  return res.rows[0] || null;
}

// Mesma lógica de voidAffiliateCommission (ver acima): reembolso/chargeback/
// cancelamento nunca pode deixar comissão de indicação "a pagar" por uma
// venda que se desfez.
async function voidReferralCommission(caktoOrderId) {
  const existing = await pool.query("SELECT * FROM referral_commissions WHERE cakto_order_id = $1", [caktoOrderId]);
  const commission = existing.rows[0];
  if (!commission) return null;
  if (commission.paid) return commission;
  await pool.query("DELETE FROM referral_commissions WHERE id = $1", [commission.id]);
  return commission;
}

// ---------- Comunidade de embaixadores ----------

async function getCommunityByAffiliateId(affiliateId) {
  const res = await pool.query("SELECT * FROM communities WHERE affiliate_id = $1", [affiliateId]);
  return res.rows[0] || null;
}

async function getCommunityById(id) {
  const res = await pool.query("SELECT * FROM communities WHERE id = $1", [id]);
  return res.rows[0] || null;
}

// Cria a comunidade JÁ com um canal "Geral" (uma comunidade sem canal
// nenhum não tem onde postar) — o embaixador cria canais extras depois
// pela própria tela.
async function createCommunity(affiliateId, name, photoUrl) {
  const res = await pool.query(
    `INSERT INTO communities (affiliate_id, name, photo_url) VALUES ($1, $2, $3)
     ON CONFLICT (affiliate_id) DO NOTHING RETURNING *`,
    [affiliateId, name, photoUrl || null]
  );
  const community = res.rows[0] || (await getCommunityByAffiliateId(affiliateId));
  if (res.rows[0]) {
    await pool.query("INSERT INTO community_channels (community_id, name, position) VALUES ($1, 'Geral', 0)", [community.id]);
  }
  return community;
}

async function updateCommunityDetails(id, { name, description, photoUrl }) {
  const res = await pool.query(
    `UPDATE communities SET
       name = COALESCE($1, name),
       description = $2,
       photo_url = COALESCE($3, photo_url)
     WHERE id = $4 RETURNING *`,
    [name || null, description ?? null, photoUrl || null, id]
  );
  return res.rows[0] || null;
}

// ---------- Canais ----------

async function listCommunityChannels(communityId) {
  const res = await pool.query("SELECT * FROM community_channels WHERE community_id = $1 ORDER BY position ASC, id ASC", [
    communityId,
  ]);
  return res.rows;
}

async function getCommunityChannelById(id) {
  const res = await pool.query("SELECT * FROM community_channels WHERE id = $1", [id]);
  return res.rows[0] || null;
}

async function createCommunityChannel(communityId, name, groupName) {
  const maxPos = await pool.query("SELECT COALESCE(MAX(position), -1) AS max_pos FROM community_channels WHERE community_id = $1", [
    communityId,
  ]);
  const res = await pool.query(
    "INSERT INTO community_channels (community_id, name, group_name, position) VALUES ($1, $2, $3, $4) RETURNING *",
    [communityId, name, groupName || null, maxPos.rows[0].max_pos + 1]
  );
  return res.rows[0];
}

// Não deixa apagar o último canal restante — sem isso a comunidade fica
// sem lugar nenhum pra postar.
async function deleteCommunityChannel(id) {
  const channel = await getCommunityChannelById(id);
  if (!channel) return null;
  const remaining = await pool.query("SELECT COUNT(*)::int AS count FROM community_channels WHERE community_id = $1", [
    channel.community_id,
  ]);
  if (remaining.rows[0].count <= 1) {
    throw new Error("Não é possível apagar o último canal da comunidade.");
  }
  await pool.query("DELETE FROM community_channels WHERE id = $1", [id]);
  return channel;
}

// Uma organização só pode estar numa comunidade na vida (organization_id é
// UNIQUE) — null quer dizer "ainda não entrou em nenhuma".
async function getCommunityMembershipByOrgId(organizationId) {
  const res = await pool.query("SELECT * FROM community_members WHERE organization_id = $1", [organizationId]);
  return res.rows[0] || null;
}

// Idempotente (ON CONFLICT DO NOTHING): tanto pro reenvio de webhook (join
// automático via link de afiliado) quanto pra evitar corrida se a pessoa
// clicar "Participar" duas vezes.
async function joinCommunity(communityId, organizationId) {
  await pool.query(
    `INSERT INTO community_members (community_id, organization_id) VALUES ($1, $2)
     ON CONFLICT (organization_id) DO NOTHING`,
    [communityId, organizationId]
  );
  return getCommunityMembershipByOrgId(organizationId);
}

// "Ativo" = organização não vencida — mesma definição que já bloqueia login
// em requireAuth (server.js), não um conceito novo. É essa contagem que
// decide o nível/percentual do embaixador a cada renovação (ver
// communityTiers.js e cakto.js).
async function countActiveCommunityMembers(communityId) {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM community_members cm
     JOIN organizations o ON o.id = cm.organization_id
     WHERE cm.community_id = $1 AND o.expires_at > now()`,
    [communityId]
  );
  return res.rows[0].count;
}

// Lista pra tela de "participar de uma comunidade" — só comunidades
// existentes, com quantos membros ativos cada uma já tem (prova social) e
// quem é o embaixador dono.
async function listCommunitiesDirectory() {
  // Contagem agregada num subquery À PARTE (não um GROUP BY que misture
  // communities.name e affiliates.name na mesma consulta) — sem isso
  // esbarra num bug do pg-mem que confunde os dois "name" de tabelas
  // diferentes no agrupamento (nunca aconteceria no Postgres real, mas sem
  // reescrever assim não dava pra testar essa tela localmente).
  const res = await pool.query(`
    SELECT c.id, c.name AS community_name, c.description, c.photo_url, a.name AS ambassador_name,
      COALESCE(m.active_member_count, 0)::int AS active_member_count
    FROM communities c
    JOIN affiliates a ON a.id = c.affiliate_id
    LEFT JOIN (
      SELECT cm.community_id, SUM(CASE WHEN o.expires_at > now() THEN 1 ELSE 0 END) AS active_member_count
      FROM community_members cm
      JOIN organizations o ON o.id = cm.organization_id
      GROUP BY cm.community_id
    ) m ON m.community_id = c.id
    ORDER BY active_member_count DESC, c.created_at ASC
  `);
  return res.rows;
}

async function createCommunityPost({ communityId, channelId, body, imageUrl }) {
  const res = await pool.query(
    `INSERT INTO community_posts (community_id, channel_id, body, image_url) VALUES ($1, $2, $3, $4) RETURNING *`,
    [communityId, channelId, body, imageUrl || null]
  );
  return res.rows[0];
}

// Curtida agregada em subquery à parte (mesmo motivo do directory acima:
// evita qualquer GROUP BY que possa esbarrar em limitação do pg-mem) +
// LEFT JOIN da curtida do PRÓPRIO usuário pra saber se ele já curtiu, sem
// usar `EXISTS`/subquery correlacionada no SELECT (não testado contra
// pg-mem, mas esse padrão de JOIN já é comprovado seguro aqui). Fixado
// sempre primeiro, depois ordena por data ou por curtidas conforme pedido.
async function listCommunityPostsByChannel(channelId, viewerUserId, sort = "recent") {
  const orderBy = sort === "likes" ? "p.pinned DESC, like_count DESC, p.created_at DESC" : "p.pinned DESC, p.created_at DESC";
  const res = await pool.query(
    `SELECT p.*, COALESCE(l.like_count, 0)::int AS like_count, (ul.id IS NOT NULL) AS liked_by_me
     FROM community_posts p
     LEFT JOIN (SELECT post_id, COUNT(*) AS like_count FROM community_post_likes GROUP BY post_id) l ON l.post_id = p.id
     LEFT JOIN community_post_likes ul ON ul.post_id = p.id AND ul.user_id = $2
     WHERE p.channel_id = $1
     ORDER BY ${orderBy}`,
    [channelId, viewerUserId]
  );
  return res.rows;
}

// Toggle: se já curtiu, remove; se não, adiciona. Devolve o novo estado
// ({liked: bool}) pra UI atualizar sem precisar recarregar o post inteiro.
async function toggleCommunityPostLike(postId, userId) {
  const existing = await pool.query("SELECT id FROM community_post_likes WHERE post_id = $1 AND user_id = $2", [
    postId,
    userId,
  ]);
  if (existing.rows[0]) {
    await pool.query("DELETE FROM community_post_likes WHERE id = $1", [existing.rows[0].id]);
    return { liked: false };
  }
  await pool.query("INSERT INTO community_post_likes (post_id, user_id) VALUES ($1, $2)", [postId, userId]);
  return { liked: true };
}

async function getCommunityPostById(id) {
  const res = await pool.query("SELECT * FROM community_posts WHERE id = $1", [id]);
  return res.rows[0] || null;
}

async function updateCommunityPost(id, { body, imageUrl }) {
  const res = await pool.query(
    "UPDATE community_posts SET body = $1, image_url = $2 WHERE id = $3 RETURNING *",
    [body, imageUrl ?? null, id]
  );
  return res.rows[0] || null;
}

async function deleteCommunityPost(id) {
  await pool.query("DELETE FROM community_posts WHERE id = $1", [id]);
}

async function toggleCommunityPostPin(id) {
  const res = await pool.query("UPDATE community_posts SET pinned = NOT pinned WHERE id = $1 RETURNING *", [id]);
  return res.rows[0] || null;
}

async function createCommunityComment({ postId, authorUserId, authorName, isAmbassador, body }) {
  const res = await pool.query(
    `INSERT INTO community_comments (post_id, author_user_id, author_name, is_ambassador, body)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [postId, authorUserId, authorName, isAmbassador, body]
  );
  return res.rows[0];
}

// Busca via JOIN em community_posts filtrando por community_id, em vez de
// receber uma lista de IDs de post e usar `= ANY($1::int[])` — achado
// testando localmente: esse operador com array de parâmetro devolve vazio
// no pg-mem (bug do simulador, não reproduzido isolado; provável limitação
// dele com esse padrão específico de bind). JOIN direto é tão simples
// quanto e não depende de nenhum comportamento exótico do driver.
async function listCommunityCommentsForCommunity(communityId) {
  const res = await pool.query(
    `SELECT cc.* FROM community_comments cc
     JOIN community_posts cp ON cp.id = cc.post_id
     WHERE cp.community_id = $1
     ORDER BY cc.created_at ASC`,
    [communityId]
  );
  return res.rows;
}

// ON CONFLICT DO NOTHING (cakto_order_id UNIQUE): mesmo motivo dos outros
// dois sistemas de comissão — reenvio de webhook não pode gerar comissão
// em dobro pro mesmo pedido.
async function createCommunityCommission({
  communityId,
  organizationId,
  caktoOrderId,
  customerEmail,
  customerName,
  saleAmount,
  memberCountAtTime,
  tier,
  commissionPercentage,
  commissionValue,
}) {
  const res = await pool.query(
    `INSERT INTO community_commissions
       (community_id, organization_id, cakto_order_id, customer_email, customer_name, sale_amount, member_count_at_time, tier, commission_percentage, commission_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (cakto_order_id) DO NOTHING
     RETURNING *`,
    [communityId, organizationId, caktoOrderId, customerEmail, customerName || null, saleAmount, memberCountAtTime, tier, commissionPercentage, commissionValue]
  );
  return res.rows[0] || null;
}

async function listCommunityCommissions() {
  const res = await pool.query(`
    SELECT cc.*, c.name AS community_name, a.name AS ambassador_name, a.pix_key AS ambassador_pix_key
    FROM community_commissions cc
    JOIN communities c ON c.id = cc.community_id
    JOIN affiliates a ON a.id = c.affiliate_id
    ORDER BY cc.created_at DESC
  `);
  return res.rows;
}

async function markCommunityCommissionPaid(id, paid) {
  const res = await pool.query(
    "UPDATE community_commissions SET paid = $1, paid_at = CASE WHEN $1 THEN now() ELSE NULL END WHERE id = $2 RETURNING *",
    [paid, id]
  );
  return res.rows[0] || null;
}

async function voidCommunityCommission(caktoOrderId) {
  const existing = await pool.query("SELECT * FROM community_commissions WHERE cakto_order_id = $1", [caktoOrderId]);
  const commission = existing.rows[0];
  if (!commission) return null;
  if (commission.paid) return commission;
  await pool.query("DELETE FROM community_commissions WHERE id = $1", [commission.id]);
  return commission;
}

// Visão geral pro admin (aba Comunidades): uma linha por comunidade
// existente, já com contagem de membros ativos e total pendente/pago —
// mesmo formato que Afiliados/Indicações já usam.
async function listCommunitiesAdminOverview() {
  // Mesmo ajuste de listCommunitiesDirectory acima (subquery à parte pra
  // não misturar communities.name e affiliates.name num GROUP BY só).
  const res = await pool.query(`
    SELECT c.id, c.affiliate_id, c.name AS community_name, c.photo_url, c.created_at,
      a.name AS ambassador_name, a.cakto_email AS ambassador_email, a.pix_key AS ambassador_pix_key,
      COALESCE(m.active_member_count, 0)::int AS active_member_count
    FROM communities c
    JOIN affiliates a ON a.id = c.affiliate_id
    LEFT JOIN (
      SELECT cm.community_id, SUM(CASE WHEN o.expires_at > now() THEN 1 ELSE 0 END) AS active_member_count
      FROM community_members cm
      JOIN organizations o ON o.id = cm.organization_id
      GROUP BY cm.community_id
    ) m ON m.community_id = c.id
    ORDER BY active_member_count DESC
  `);
  return res.rows;
}

function planLimitsFor(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.solo;
}

async function createOrganization({ name, plan, billingCycle, notes }) {
  const days = BILLING_CYCLE_DAYS[billingCycle];
  const res = await pool.query(
    `INSERT INTO organizations (name, plan, billing_cycle, expires_at, notes)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5) RETURNING *`,
    [name, plan, billingCycle, days, notes || null]
  );
  return res.rows[0];
}

// Mesmo formato de createOrganization, mas grava a referência da compra
// Cakto que originou essa organização (ver colunas cakto_* em migrate()) —
// é o que permite um evento de cancelamento/reembolso futuro achar essa
// organização de volta.
async function createOrganizationFromCakto({ name, plan, billingCycle, notes, purchaseId, customerEmail }) {
  const days = BILLING_CYCLE_DAYS[billingCycle];
  const res = await pool.query(
    `INSERT INTO organizations (name, plan, billing_cycle, expires_at, notes, cakto_purchase_id, cakto_customer_email)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5, $6, $7) RETURNING *`,
    [name, plan, billingCycle, days, notes || null, purchaseId, customerEmail]
  );
  return res.rows[0];
}

async function findOrganizationByCaktoPurchaseId(purchaseId) {
  const res = await pool.query("SELECT * FROM organizations WHERE cakto_purchase_id = $1", [purchaseId]);
  return res.rows[0] || null;
}

// Fallback pra quando o evento de cancelamento/reembolso não referencia o
// mesmo purchase_id da compra original (ex: é o ID da assinatura, não da
// transação) — busca pelo email do comprador. Mais de uma organização pode
// bater (ex: reembolso parcial num histórico antigo) — devolve a mais
// recente, quem chama decide se faz sentido.
async function findOrganizationByCaktoEmail(email) {
  const res = await pool.query(
    "SELECT * FROM organizations WHERE cakto_customer_email = $1 ORDER BY created_at DESC LIMIT 1",
    [email.toLowerCase().trim()]
  );
  return res.rows[0] || null;
}

// Idempotência: devolve true só na primeira vez que esse (purchase_id, event)
// é visto — reenvios da Cakto (retry automático dela) batem no
// ON CONFLICT DO NOTHING e voltam false, sinal pra quem chamou responder
// 200 sem reprocessar (criar organização/usuário duplicado).
async function recordCaktoEvent(purchaseId, event) {
  const res = await pool.query(
    `INSERT INTO cakto_events (purchase_id, event) VALUES ($1, $2)
     ON CONFLICT (purchase_id, event) DO NOTHING RETURNING purchase_id`,
    [purchaseId, event]
  );
  return res.rows.length > 0;
}

async function updateCaktoEventStatus(purchaseId, event, status, detail) {
  await pool.query(
    "UPDATE cakto_events SET status = $1, detail = $2 WHERE purchase_id = $3 AND event = $4",
    [status, detail || null, purchaseId, event]
  );
}

async function getOrganizationById(id) {
  const res = await pool.query("SELECT * FROM organizations WHERE id = $1", [id]);
  return res.rows[0] || null;
}

async function countUsersInOrg(organizationId) {
  const res = await pool.query("SELECT COUNT(*)::int AS n FROM app_users WHERE organization_id = $1", [
    organizationId,
  ]);
  return res.rows[0].n;
}

async function getOrgMemberIds(organizationId) {
  const res = await pool.query("SELECT id FROM app_users WHERE organization_id = $1", [organizationId]);
  return res.rows.map((r) => r.id);
}

async function listOrganizationsWithCounts() {
  const res = await pool.query(`
    SELECT o.*, COUNT(u.id)::int AS user_count
    FROM organizations o
    LEFT JOIN app_users u ON u.organization_id = o.id
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `);
  return res.rows;
}

// Renovar ANTES de vencer estende a partir da validade atual (não perde o
// tempo que ainda restava); renovar DEPOIS de vencer (relapso) conta a
// partir de agora (não empilha em cima de uma data já bem no passado).
// Também é o caminho usado pra trocar de plano — muda plano+ciclo junto,
// nunca separado, pra não deixar uma combinação plano-A/ciclo-B inconsistente.
async function renewOrganization(id, plan, billingCycle) {
  const org = await getOrganizationById(id);
  if (!org) return null;
  const days = BILLING_CYCLE_DAYS[billingCycle];
  const base = new Date(org.expires_at) > new Date() ? "expires_at" : "now()";
  const res = await pool.query(
    `UPDATE organizations SET plan = $1, billing_cycle = $2, expires_at = ${base} + ($3 || ' days')::interval
     WHERE id = $4 RETURNING *`,
    [plan, billingCycle, days, id]
  );
  return res.rows[0];
}

// Upgrade/downgrade de plano SEM mexer na validade — diferente de
// renewOrganization: usado quando o cliente já pagou a diferença fora do
// app (ex: upgrade no meio do ciclo) e não deve ganhar dias extras de
// brinde nem perder o que já pagou só porque trocou de plano.
async function changeOrganizationPlan(id, plan, billingCycle) {
  const res = await pool.query(
    `UPDATE organizations SET plan = $1, billing_cycle = $2 WHERE id = $3 RETURNING *`,
    [plan, billingCycle, id]
  );
  return res.rows[0];
}

// Escape-hatch manual — cortesia de renovação, correção, ou cancelamento
// antecipado (setar pro passado bloqueia o login na hora, mesmo sem
// cancelamento formal).
async function updateOrganizationExpiry(id, expiresAt) {
  const res = await pool.query("UPDATE organizations SET expires_at = $1 WHERE id = $2 RETURNING *", [
    expiresAt,
    id,
  ]);
  return res.rows[0];
}

// Exclui a organização. Só chega aqui depois do servidor confirmar que
// nenhum app_user aponta mais pra ela (ver checagem em server.js) — a
// própria coluna organization_id em app_users é REFERENCES organizations(id)
// sem ON DELETE, então o Postgres já recusaria sozinho se sobrasse algum
// usuário, mas o servidor confere ANTES pra devolver uma mensagem clara em
// vez de deixar estourar um erro de constraint cru pro admin.
async function deleteOrganization(id) {
  await pool.query("DELETE FROM organizations WHERE id = $1", [id]);
}

async function updateOrganizationDetails(id, { name, notes }) {
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) {
    fields.push(`name = $${i++}`);
    values.push(name);
  }
  if (notes !== undefined) {
    fields.push(`notes = $${i++}`);
    values.push(notes);
  }
  if (fields.length === 0) return;
  values.push(id);
  await pool.query(`UPDATE organizations SET ${fields.join(", ")} WHERE id = $${i}`, values);
}

async function historySummaryForUser(appUserId) {
  const res = await pool.query(
    `SELECT domain, tool, COUNT(*)::int AS count, MAX(created_at) AS last_at
     FROM search_logs
     WHERE app_user_id = $1
     GROUP BY domain, tool
     ORDER BY count DESC, last_at DESC`,
    [appUserId]
  );
  return res.rows;
}

module.exports = {
  pool,
  PLAN_LIMITS,
  BILLING_CYCLE_DAYS,
  planLimitsFor,
  migrate,
  ensureMineradorDatabase,
  countUsers,
  countActiveAdmins,
  createUser,
  findUserByEmail,
  getAppUserById,
  touchLastSeen,
  listUsersWithCounts,
  updateUserPermissions,
  updateUserPassword,
  recordFailedLogin,
  resetFailedLogins,
  deleteUser,
  updateUserAvatar,
  updateUserName,
  logSearch,
  historySummaryForUser,
  logLogin,
  ipSummaryForUser,
  logAdminAction,
  listAdminAuditLog,
  listAffiliates,
  findAffiliateByCaktoEmail,
  createAffiliate,
  deleteAffiliate,
  createAffiliateCommission,
  listAffiliateCommissions,
  markAffiliateCommissionPaid,
  voidAffiliateCommission,
  getReferralCouponByUserId,
  findReferralCouponByCode,
  createReferralCouponRequest,
  updateReferralCouponPix,
  updateReferralCouponWhatsapp,
  listReferralCoupons,
  activateReferralCoupon,
  createReferralCommission,
  listReferralCommissionsByUserId,
  listReferralCommissions,
  markReferralCommissionPaid,
  voidReferralCommission,
  getCommunityByAffiliateId,
  getCommunityById,
  createCommunity,
  updateCommunityDetails,
  listCommunityChannels,
  getCommunityChannelById,
  createCommunityChannel,
  deleteCommunityChannel,
  getCommunityMembershipByOrgId,
  joinCommunity,
  countActiveCommunityMembers,
  listCommunitiesDirectory,
  createCommunityPost,
  listCommunityPostsByChannel,
  toggleCommunityPostLike,
  getCommunityPostById,
  updateCommunityPost,
  deleteCommunityPost,
  toggleCommunityPostPin,
  createCommunityComment,
  listCommunityCommentsForCommunity,
  createCommunityCommission,
  listCommunityCommissions,
  markCommunityCommissionPaid,
  voidCommunityCommission,
  listCommunitiesAdminOverview,
  createOrganization,
  createOrganizationFromCakto,
  findOrganizationByCaktoPurchaseId,
  findOrganizationByCaktoEmail,
  recordCaktoEvent,
  updateCaktoEventStatus,
  completePasswordSetup,
  getOrganizationById,
  countUsersInOrg,
  getOrgMemberIds,
  listOrganizationsWithCounts,
  renewOrganization,
  changeOrganizationPlan,
  setOrgDefaultOperationIfUnset,
  setOrgDefaultOperation,
  updateOrganizationExpiry,
  updateOrganizationDetails,
  deleteOrganization,
};
