const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");
const caktoApi = require("./caktoApi");
const { tierForActiveMembers } = require("./communityTiers");

// offer.id (link de pagamento) → plano interno + ciclo de cobrança. Vem dos
// 9 links que o Samuel mandou (3 planos × 3 ciclos). O slug do "Standard
// Mensal" tem um sufixo diferente dos outros 8 (assinatura em vez de
// pagamento único?) — ainda não confirmado contra um payload real, ver
// aviso em CAKTO_OFFER_ID_NEEDS_CONFIRMATION abaixo.
const CAKTO_OFFER_PLAN_MAP = {
  n9nmo5z: { plan: "agencia", billingCycle: "anual", label: "Enterprise Anual" },
  i34oc79: { plan: "pro", billingCycle: "anual", label: "PRO Anual" },
  zfj4e84: { plan: "solo", billingCycle: "anual", label: "Standard Anual" },
  "39f359d": { plan: "pro", billingCycle: "trimestral", label: "PRO Trimestral" },
  w4vvcev: { plan: "solo", billingCycle: "trimestral", label: "Standard Trimestral" },
  "3do9zbx": { plan: "agencia", billingCycle: "trimestral", label: "Enterprise Trimestral" },
  "3gx6bit": { plan: "agencia", billingCycle: "mensal", label: "Enterprise Mensal" },
  t9c4v6c: { plan: "pro", billingCycle: "mensal", label: "PRO Mensal" },
  "52ytvd7": { plan: "solo", billingCycle: "mensal", label: "Standard Mensal" },

  // Produto duplicado na Cakto (2026-08-31) por causa do reajuste de preço —
  // editar o preço do produto ANTIGO reajustaria a recorrência de quem já é
  // assinante, então os 9 links abaixo são um produto NOVO, com webhook
  // próprio (secret também precisa bater, ver CAKTO_WEBHOOK_SECRET). Os 9
  // links ANTIGOS acima continuam aqui de propósito — assinantes antigos
  // continuam renovando por eles no preço de antes, pra sempre.
  zrhtj34: { plan: "solo", billingCycle: "mensal", label: "Standard Mensal (novo)" },
  zwbuutf: { plan: "pro", billingCycle: "mensal", label: "PRO Mensal (novo)" },
  m8ih6hc: { plan: "agencia", billingCycle: "mensal", label: "Enterprise Mensal (novo)" },
  "3b56i8v": { plan: "agencia", billingCycle: "trimestral", label: "Enterprise Trimestral (novo)" },
  "8umv5gq": { plan: "solo", billingCycle: "trimestral", label: "Standard Trimestral (novo)" },
  "3dpynx5": { plan: "pro", billingCycle: "trimestral", label: "PRO Trimestral (novo)" },
  "36wjk7s": { plan: "solo", billingCycle: "anual", label: "Standard Anual (novo)" },
  cpspn3i: { plan: "pro", billingCycle: "anual", label: "PRO Anual (novo)" },
  "9j9t3aq": { plan: "agencia", billingCycle: "anual", label: "Enterprise Anual (novo)" },
};

// Nomes confirmados na documentação oficial da Cakto
// (docs.cakto.com.br/conceitos/webhooks.md, lido em 2026-08-24) — não são
// mais chute, mas TAMBÉM nunca foram testados contra um payload real de
// cada um (só o "purchase_approved" veio de uma compra de teste de
// verdade). Antes de confiar 100%, dispare um "Evento de Teste" de cada um
// desses no painel da Cakto (Integrações → Webhooks → seu webhook → testar)
// e confira no log do Railway se handleCancellationEvent achou a
// organização certa. "subscription_renewal_refused" (pagamento da
// renovação recusado) fica de fora de propósito — não é bem um
// cancelamento, precisa decidir com o Samuel se isso também suspende ou só
// avisa.
const CANCELLATION_EVENTS = new Set(["refund", "chargeback", "subscription_canceled"]);

// Senha PLACEHOLDER — ninguém nunca vê esse valor, nem loga, nem entrega
// em lugar nenhum. Existe só porque password_hash é NOT NULL. A conta
// nasce com needs_password_setup=true (ver createUser abaixo); a pessoa
// escolhe a PRÓPRIA senha de verdade em POST /registrar (server.js),
// provando que é dona da compra ao digitar o mesmo email usado na Cakto.
// Longa e aleatória de propósito — mesmo sendo descartada, não custa nada
// ela ser inadivinhável enquanto existir.
function generateUnusablePlaceholderPassword() {
  return crypto.randomBytes(32).toString("base64url");
}

// Compara o secret do corpo do webhook contra CAKTO_WEBHOOK_SECRET.
// timingSafeEqual exige buffers do mesmo tamanho — se o secret recebido tem
// tamanho diferente do configurado já não bate mesmo, então cai direto no
// "false" sem chamar timingSafeEqual (que lançaria erro no length mismatch).
function isValidSecret(received) {
  const expected = process.env.CAKTO_WEBHOOK_SECRET;
  if (!expected || !received || typeof received !== "string") return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Descobre qual afiliado (se algum) está ligado a um pedido, buscando na
// API de Pedidos da Cakto (o webhook em si não manda essa informação, ver
// caktoApi.js:getOrder). `emailSeenButUnregistered` distingue "a Cakto não
// rastreou afiliado nenhum nesse pedido" (não avisa nada, é o caso normal)
// de "a Cakto rastreou um afiliado, mas esse email não está cadastrado no
// nosso painel" (esse sim precisa virar aviso pro admin cadastrar).
// Extraído numa função à parte pra ser reaproveitado tanto por
// recordAffiliateCommissionIfAny (comissão de afiliado) quanto por
// autoJoinCommunityIfAny (entrada automática na comunidade dele) sem bater
// na API da Cakto duas vezes pro mesmo pedido.
async function resolveAffiliateForOrder(data) {
  const order = await caktoApi.getOrder(data.id);
  const affiliateCommission = (order.commissions || []).find((c) => c.type === "affiliate");
  if (!affiliateCommission) return { affiliate: null, order, emailSeenButUnregistered: null };
  const commissionedUser = (order.commissionedUsers || []).find(
    (u) => String(u.id) === String(affiliateCommission.userId)
  );
  if (!commissionedUser?.email) return { affiliate: null, order, emailSeenButUnregistered: null };
  const affiliate = await db.findAffiliateByCaktoEmail(commissionedUser.email);
  return { affiliate, order, emailSeenButUnregistered: affiliate ? null : commissionedUser.email };
}

// Programa de afiliados feito por dentro do app (ver db.js — a Cakto só
// suporta uma comissão fixa por produto, não uma taxa pra primeira venda e
// outra pra recorrência). Calcula a comissão com a NOSSA taxa (não a da
// Cakto). Nunca deixa uma falha aqui derrubar o processamento do webhook em
// si — a organização já foi criada/renovada com sucesso antes de chamar
// isso. Aceita um `resolved` já calculado (ver handlePurchaseApproved, ramo
// de organização nova) pra não bater na API da Cakto de novo à toa.
async function recordAffiliateCommissionIfAny(data, commissionType, resolved) {
  try {
    const { affiliate, order, emailSeenButUnregistered } = resolved || (await resolveAffiliateForOrder(data));
    if (!affiliate) {
      if (emailSeenButUnregistered) {
        console.warn(
          `Webhook Cakto: pedido ${data.id} tem afiliado (${emailSeenButUnregistered}) que não está cadastrado no nosso painel — comissão NÃO registrada, cadastre esse afiliado.`
        );
      }
      return;
    }
    const percentage =
      commissionType === "first_sale" ? affiliate.first_sale_percentage : affiliate.recurring_percentage;
    const saleAmount = Number(order.amount ?? data.amount ?? 0);
    const commissionValue = Math.round(saleAmount * (Number(percentage) / 100) * 100) / 100;
    const inserted = await db.createAffiliateCommission({
      affiliateId: affiliate.id,
      caktoOrderId: data.id,
      customerEmail: String(data.customer?.email || "").trim().toLowerCase(),
      customerName: data.customer?.name || null,
      saleAmount,
      commissionType,
      commissionPercentage: percentage,
      commissionValue,
    });
    if (inserted) {
      console.log(
        `Webhook Cakto: comissão de ${commissionValue} registrada pra ${affiliate.name} (${commissionType}, pedido ${data.id}).`
      );
    }
  } catch (err) {
    console.error(`Webhook Cakto: falha ao conferir comissão de afiliado pro pedido ${data.id}:`, err.message);
  }
}

// Indicação (cliente indica cliente, 2026-09-10) — diferente do programa de
// afiliados acima: aqui quem indica é identificado pelo `couponCode` que
// veio no próprio payload do webhook (confirmado na doc oficial da Cakto,
// não precisa da API extra de pedidos). Decisão do usuário: comissão de
// 50% só na PRIMEIRA compra do indicado (não em renovação) — por isso só é
// chamada a partir do ramo de organização NOVA em handlePurchaseApproved,
// nunca do ramo de renovação nem de handleSubscriptionRenewed.
const REFERRAL_COMMISSION_PERCENTAGE = 50;

async function recordReferralCommissionIfAny(data) {
  const couponCode = String(data.couponCode || "").trim();
  if (!couponCode) return;
  try {
    const coupon = await db.findReferralCouponByCode(couponCode);
    if (!coupon) return; // cupom usado não é de indicação (ou não está mais ativo)
    const saleAmount = Number(data.offer?.price ?? data.amount ?? 0);
    const commissionValue = Math.round(saleAmount * (REFERRAL_COMMISSION_PERCENTAGE / 100) * 100) / 100;
    const inserted = await db.createReferralCommission({
      referralCouponId: coupon.id,
      caktoOrderId: data.id,
      customerEmail: String(data.customer?.email || "").trim().toLowerCase(),
      customerName: data.customer?.name || null,
      saleAmount,
      commissionPercentage: REFERRAL_COMMISSION_PERCENTAGE,
      commissionValue,
    });
    if (inserted) {
      console.log(`Webhook Cakto: comissão de indicação de ${commissionValue} registrada pro cupom ${couponCode} (pedido ${data.id}).`);
    }
  } catch (err) {
    console.error(`Webhook Cakto: falha ao conferir comissão de indicação pro pedido ${data.id}:`, err.message);
  }
}

// Comunidade de embaixadores (2026-09-10) — quando alguém assina pelo link
// de afiliado de um embaixador que já tem comunidade, a organização entra
// automaticamente nela. Só roda no ramo de organização NOVA (a pessoa só
// entra numa comunidade na primeira compra, nunca de novo depois).
async function autoJoinCommunityIfAny(affiliate, org) {
  if (!affiliate) return;
  try {
    const community = await db.getCommunityByAffiliateId(affiliate.id);
    if (!community) return; // esse afiliado ainda não virou embaixador (sem comunidade criada)
    await db.joinCommunity(community.id, org.id);
    console.log(`Webhook Cakto: organização "${org.name}" entrou automaticamente na comunidade "${community.name}" (afiliado ${affiliate.name}).`);
  } catch (err) {
    console.error(`Webhook Cakto: falha ao entrar automaticamente na comunidade pra organização "${org.name}":`, err.message);
  }
}

// Comissão de comunidade — diferente das duas acima: dispara em TODA
// renovação de QUALQUER membro ativo (não só na primeira compra), porque é
// isso que "recorrência" quer dizer aqui (decisão do usuário). Sem job
// agendado: o nível/percentual é calculado NA HORA, contando quantos
// membros ativos a comunidade tem NESSE INSTANTE — se a comunidade
// cresceu/encolheu desde a última renovação, a % já reflete isso
// automaticamente, sem precisar recalcular nada em lote depois.
async function recordCommunityCommissionIfAny(data, org) {
  try {
    const membership = await db.getCommunityMembershipByOrgId(org.id);
    if (!membership) return; // organização não está em nenhuma comunidade
    const community = await db.getCommunityById(membership.community_id);
    if (!community) return;
    const activeCount = await db.countActiveCommunityMembers(community.id);
    const tier = tierForActiveMembers(activeCount);
    const saleAmount = Number(data.offer?.price ?? data.amount ?? 0);
    const commissionValue = Math.round(saleAmount * (tier.percentage / 100) * 100) / 100;
    const inserted = await db.createCommunityCommission({
      communityId: community.id,
      organizationId: org.id,
      caktoOrderId: data.id,
      customerEmail: String(data.customer?.email || "").trim().toLowerCase(),
      customerName: data.customer?.name || null,
      saleAmount,
      memberCountAtTime: activeCount,
      tier: tier.name,
      commissionPercentage: tier.percentage,
      commissionValue,
    });
    if (inserted) {
      console.log(
        `Webhook Cakto: comissão de comunidade de ${commissionValue} (nível ${tier.label}, ${activeCount} membros ativos) registrada pra comunidade "${community.name}" (pedido ${data.id}).`
      );
    }
  } catch (err) {
    console.error(`Webhook Cakto: falha ao conferir comissão de comunidade pro pedido ${data.id}:`, err.message);
  }
}

async function handlePurchaseApproved(data) {
  const email = String(data.customer?.email || "").trim().toLowerCase();
  const name = String(data.customer?.name || "").trim();
  const offerId = data.offer?.id;
  if (!email || !name || !offerId) {
    throw new Error(`payload incompleto pra criar organização (email=${email || "?"}, name=${name || "?"}, offerId=${offerId || "?"})`);
  }

  const mapping = CAKTO_OFFER_PLAN_MAP[offerId];
  if (!mapping) {
    throw new Error(
      `offer.id "${offerId}" não está mapeado em CAKTO_OFFER_PLAN_MAP (web/cakto.js) — compra ${data.id} de ${email} NÃO gerou acesso, mapeie manualmente ou adicione essa oferta no código`
    );
  }

  const planLabel = db.planLimitsFor(mapping.plan).label;

  const existing = await db.findUserByEmail(email);
  if (existing) {
    // Já existe usuário com esse email. Se a organização dele já veio de
    // uma compra Cakto anterior, tratamos como renovação (mesma pessoa
    // comprando de novo no ciclo seguinte) — estende o plano em vez de
    // tentar criar tudo de novo. Se não veio da Cakto (conta criada
    // manualmente pelo admin, ou de outra organização), não sabemos o que
    // fazer com segurança — melhor falhar alto (fica visível no log e no
    // painel da Cakto) do que silenciosamente ignorar uma compra paga.
    const org = existing.organization_id ? await db.getOrganizationById(existing.organization_id) : null;
    if (org && org.cakto_purchase_id) {
      await db.renewOrganization(org.id, mapping.plan, mapping.billingCycle);
      await db.logAdminAction(
        null,
        "Cakto (automático)",
        existing.id,
        existing.name,
        "org_renewed",
        `Plano ${planLabel} · ${mapping.billingCycle} · renovação via Cakto, compra ${data.id}`
      );
      console.log(`Webhook Cakto: organização "${org.name}" renovada (${planLabel}/${mapping.billingCycle}) a partir da compra ${data.id}.`);
      await recordAffiliateCommissionIfAny(data, "recurring");
      await recordCommunityCommissionIfAny(data, org);
      return;
    }
    throw new Error(
      `já existe um usuário com o email ${email} (id ${existing.id}) que não veio da Cakto — compra ${data.id} não foi processada automaticamente, revise manualmente`
    );
  }

  const passwordHash = await bcrypt.hash(generateUnusablePlaceholderPassword(), 10);
  const org = await db.createOrganizationFromCakto({
    name: `${name} (Cakto)`,
    plan: mapping.plan,
    billingCycle: mapping.billingCycle,
    notes: `Criado automaticamente via webhook Cakto, compra ${data.id}, oferta "${mapping.label}"`,
    purchaseId: data.id,
    customerEmail: email,
  });
  const user = await db.createUser({
    name,
    email,
    passwordHash,
    role: "collaborator",
    organizationId: org.id,
    needsPasswordSetup: true,
  });
  await db.logAdminAction(
    null,
    "Cakto (automático)",
    user.id,
    user.name,
    "created",
    `Plano ${planLabel} · ${mapping.billingCycle} · compra Cakto ${data.id}`
  );
  console.log(`Webhook Cakto: organização "${org.name}" e usuário ${email} criados (${planLabel}/${mapping.billingCycle}) a partir da compra ${data.id}.`);

  // Resolve o afiliado da compra UMA vez (bate na API da Cakto) e reusa o
  // resultado tanto pra comissão de afiliado quanto pra entrada automática
  // na comunidade dele, em vez de resolver duas vezes.
  let resolvedAffiliate = null;
  try {
    resolvedAffiliate = await resolveAffiliateForOrder(data);
  } catch (err) {
    console.error(`Webhook Cakto: falha ao resolver afiliado do pedido ${data.id}:`, err.message);
  }
  await recordAffiliateCommissionIfAny(data, "first_sale", resolvedAffiliate);
  await recordReferralCommissionIfAny(data);
  await autoJoinCommunityIfAny(resolvedAffiliate?.affiliate, org);
}

async function handleCancellationEvent(data, eventName) {
  const email = String(data.customer?.email || "").trim().toLowerCase();
  let org = data.id ? await db.findOrganizationByCaktoPurchaseId(data.id) : null;
  if (!org && email) org = await db.findOrganizationByCaktoEmail(email);
  if (!org) {
    throw new Error(
      `evento "${eventName}" (compra ${data.id}, email ${email || "?"}) não achou nenhuma organização Cakto pra suspender — revise manualmente`
    );
  }
  await db.updateOrganizationExpiry(org.id, new Date());
  await db.logAdminAction(
    null,
    "Cakto (automático)",
    null,
    org.name,
    "org_renewed",
    `Acesso suspenso automaticamente (evento Cakto "${eventName}", compra ${data.id})`
  );
  console.log(`Webhook Cakto: organização "${org.name}" suspensa (evento "${eventName}", compra ${data.id}).`);

  // Pedido do usuário (2026-08-31): comissão de afiliado nunca pode ficar "a
  // pagar" pra uma venda que se desfez (reembolso/chargeback/cancelamento).
  // Se ainda não tinha sido paga, some sozinha; se já tinha sido paga, só
  // avisa no log (não dá pra puxar de volta um PIX já mandado).
  try {
    const voided = await db.voidAffiliateCommission(data.id);
    if (voided?.paid) {
      console.warn(
        `Webhook Cakto: pedido ${data.id} foi ${eventName} DEPOIS da comissão já ter sido marcada como paga — revise manualmente com o afiliado.`
      );
    } else if (voided) {
      console.log(`Webhook Cakto: comissão pendente do pedido ${data.id} removida (evento "${eventName}").`);
    }
  } catch (err) {
    console.error(`Webhook Cakto: falha ao conferir comissão de afiliado no cancelamento do pedido ${data.id}:`, err.message);
  }

  try {
    const voidedReferral = await db.voidReferralCommission(data.id);
    if (voidedReferral?.paid) {
      console.warn(
        `Webhook Cakto: pedido ${data.id} foi ${eventName} DEPOIS da comissão de indicação já ter sido marcada como paga — revise manualmente com quem indicou.`
      );
    } else if (voidedReferral) {
      console.log(`Webhook Cakto: comissão de indicação pendente do pedido ${data.id} removida (evento "${eventName}").`);
    }
  } catch (err) {
    console.error(`Webhook Cakto: falha ao conferir comissão de indicação no cancelamento do pedido ${data.id}:`, err.message);
  }

  try {
    const voidedCommunity = await db.voidCommunityCommission(data.id);
    if (voidedCommunity?.paid) {
      console.warn(
        `Webhook Cakto: pedido ${data.id} foi ${eventName} DEPOIS da comissão de comunidade já ter sido marcada como paga — revise manualmente com o embaixador.`
      );
    } else if (voidedCommunity) {
      console.log(`Webhook Cakto: comissão de comunidade pendente do pedido ${data.id} removida (evento "${eventName}").`);
    }
  } catch (err) {
    console.error(`Webhook Cakto: falha ao conferir comissão de comunidade no cancelamento do pedido ${data.id}:`, err.message);
  }
}

// "subscription_renewed": renovação de assinatura recorrente — diferente
// do fallback de renovação dentro de handlePurchaseApproved (que cobre o
// caso de a Cakto reenviar "purchase_approved" a cada ciclo). Ainda não
// testado contra um payload real, então não sabemos se data.offer vem
// preenchido aqui — se não vier, mantém o plano/ciclo que a organização já
// tinha (só estende a validade).
async function handleSubscriptionRenewed(data) {
  const email = String(data.customer?.email || "").trim().toLowerCase();
  let org = data.id ? await db.findOrganizationByCaktoPurchaseId(data.id) : null;
  if (!org && email) org = await db.findOrganizationByCaktoEmail(email);
  if (!org) {
    throw new Error(
      `evento "subscription_renewed" (compra ${data.id}, email ${email || "?"}) não achou organização Cakto pra renovar — revise manualmente`
    );
  }
  const mapping = data.offer?.id ? CAKTO_OFFER_PLAN_MAP[data.offer.id] : null;
  const plan = mapping ? mapping.plan : org.plan;
  const billingCycle = mapping ? mapping.billingCycle : org.billing_cycle;
  await db.renewOrganization(org.id, plan, billingCycle);
  await db.logAdminAction(
    null,
    "Cakto (automático)",
    null,
    org.name,
    "org_renewed",
    `Renovação automática via Cakto (evento subscription_renewed, compra ${data.id})`
  );
  console.log(`Webhook Cakto: organização "${org.name}" renovada (evento subscription_renewed, compra ${data.id}).`);
  await recordAffiliateCommissionIfAny(data, "recurring");
  await recordCommunityCommissionIfAny(data, org);
}

// Handler principal, chamado pela rota POST /api/webhooks/cakto em
// server.js. Devolve { status, body } em vez de mexer em req/res
// diretamente, só pra ficar fácil de testar isolado se um dia precisar.
async function handleCaktoWebhook(body) {
  if (!isValidSecret(body?.secret)) {
    console.error("Webhook Cakto: secret inválido ou CAKTO_WEBHOOK_SECRET não configurado.");
    return { status: 401, body: { error: "unauthorized" } };
  }

  const event = body?.event;
  const data = body?.data;
  if (!event || !data?.id) {
    return { status: 400, body: { error: "payload inválido, faltando event ou data.id" } };
  }

  // BUG CORRIGIDO (derrubou o app em produção, 2026-08-25): essa chamada
  // ficava FORA do try/catch abaixo. Qualquer falha aqui (ex: soluço de
  // conexão com o Postgres) virava uma promise rejeitada sem ninguém pra
  // pegar — como não tem handler de unhandledRejection nesse processo,
  // o Node inteiro cai, derrubando o app pra todo mundo, não só essa rota.
  // Por isso TUDO que faz await nesta função (webhook inteiro) precisa
  // estar dentro do try. Nunca deixe um await solto aqui de novo.
  try {
    const isNew = await db.recordCaktoEvent(data.id, event);
    if (!isNew) {
      // Reenvio da Cakto (retry dela) do mesmo evento — já processamos,
      // responde 200 sem fazer nada de novo (idempotência).
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    if (event === "purchase_approved") {
      await handlePurchaseApproved(data);
    } else if (CANCELLATION_EVENTS.has(event)) {
      await handleCancellationEvent(data, event);
    } else if (event === "subscription_renewed") {
      await handleSubscriptionRenewed(data);
    } else {
      console.warn(`Webhook Cakto: evento "${event}" recebido (compra ${data.id}) mas ainda não é tratado automaticamente — só logado.`);
      await db.updateCaktoEventStatus(data.id, event, "ignored_event");
      return { status: 200, body: { ok: true, handled: false } };
    }
    await db.updateCaktoEventStatus(data.id, event, "processed");
    return { status: 200, body: { ok: true } };
  } catch (err) {
    console.error(`Webhook Cakto: erro processando evento "${event}" (compra ${data.id}):`, err.message);
    // Best-effort: se o banco já tava com problema (motivo mais provável de
    // termos caído no catch em primeiro lugar), essa segunda query pode
    // falhar de novo — não deixa isso derrubar o processo, só loga.
    try {
      await db.updateCaktoEventStatus(data.id, event, "error", err.message);
    } catch (innerErr) {
      console.error(`Webhook Cakto: falha ao registrar status de erro do evento (compra ${data.id}):`, innerErr.message);
    }
    return { status: 500, body: { error: "internal error" } };
  }
}

module.exports = { handleCaktoWebhook, CAKTO_OFFER_PLAN_MAP, CANCELLATION_EVENTS };
