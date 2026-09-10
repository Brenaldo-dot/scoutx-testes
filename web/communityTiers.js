// Níveis de embaixador da Comunidade — quanto mais membros ATIVOS (organização
// não vencida) a comunidade dele tem, maior o percentual que ele ganha sobre
// a recorrência de CADA renovação de QUALQUER membro (ver cakto.js:
// recordCommunityCommissionIfAny). Recalculado a cada renovação que chega,
// não fica travado no pico — se a comunidade encolher, a % do mês seguinte
// cai junto (decisão do usuário, 2026-09-10).
const TIERS = [
  { name: "gold", label: "Gold", max: 15, percentage: 25 },
  { name: "platinum", label: "Platinum", max: 25, percentage: 30 },
  // Sem teto de membros — 26+ continua em Diamond, trava em 35% (decisão do
  // usuário: não cria um 4º nível por enquanto).
  { name: "diamond", label: "Diamond", max: Infinity, percentage: 35 },
];

function tierForActiveMembers(count) {
  return TIERS.find((t) => count <= t.max) || TIERS[TIERS.length - 1];
}

module.exports = { TIERS, tierForActiveMembers };
