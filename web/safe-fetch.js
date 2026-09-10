const dns = require("dns").promises;
// Precisa ser o `fetch` DESTE MESMO pacote undici, não o `fetch` global do
// Node — o global usa uma cópia interna do undici embutida no runtime, com
// versão diferente da instalada via npm; misturar as duas (fetch global +
// Agent daqui) quebra em runtime ("invalid onRequestStart method") porque os
// dois undici não falam o mesmo protocolo interno de dispatcher.
const { fetch, Agent } = require("undici");

// Revisão de segurança: achado num teste de invasão. Buscar Fornecedor e
// Espionar Loja fazem o SERVIDOR buscar a URL que a pessoa cola — sem essa
// checagem, qualquer usuário logado (não precisa ser admin) conseguia colar
// um endereço interno (localhost, IP privado, *.railway.internal) e usar o
// app como ponte pra sondar a rede interna da infraestrutura (SSRF).
// Resolve o hostname de verdade e bloqueia qualquer IP que caia numa faixa
// privada/reservada/loopback, nas duas versões (v4 e v6).
function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

const PRIVATE_IPV4_RANGES = [
  ["0.0.0.0", 8], // "esta rede"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — inclui o metadata de nuvem 169.254.169.254
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // reservado IETF
  ["192.0.2.0", 24], // documentação (TEST-NET-1)
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentação (TEST-NET-2)
  ["203.0.113.0", 24], // documentação (TEST-NET-3)
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservado
];

function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip);
  return PRIVATE_IPV4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true; // loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/.test(v)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(v)) return true; // fc00::/7 unique local
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]); // IPv4-mapped IPv6
  return false;
}

// Resolve o hostname, valida TODOS os endereços que ele responder, e devolve
// o primeiro (address, family) já validado — pra quem chama poder FIXAR a
// conexão de verdade nesse mesmo endereço em vez de deixar o cliente HTTP
// resolver de novo (ver createPinnedFetch abaixo, que é pra onde essa função
// deveria ir na prática).
async function assertPublicHost(hostname) {
  const host = String(hostname).toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".railway.internal")
  ) {
    throw new Error("Esse endereço não pode ser consultado.");
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("Não foi possível resolver esse endereço.");
  }
  if (addresses.length === 0) {
    throw new Error("Não foi possível resolver esse endereço.");
  }
  for (const { address, family } of addresses) {
    const isPrivate = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
    if (isPrivate) {
      throw new Error("Esse endereço não pode ser consultado.");
    }
  }
  return addresses[0];
}

// Revisão de segurança: achado num segundo teste de invasão (DNS rebinding).
// A checagem acima e a requisição de verdade eram duas resoluções de DNS
// SEPARADAS — validar o hostname e, na hora de buscar de verdade, resolver
// de novo — o que dá brecha pra quem controla o DNS do domínio responder um
// IP público na validação e um IP interno na consulta seguinte, minúsculos
// segundos depois. `createPinnedFetch` fecha essa janela: valida uma vez e
// devolve uma função `fetch` que força QUALQUER conexão (inclusive as várias
// chamadas de Espionar Loja pro mesmo domínio) a usar esse MESMO endereço já
// validado, sem resolver de novo. O hostname original continua indo no
// SNI/Host normalmente (o `lookup` do undici só troca a resolução de
// endereço, não o que é enviado pro servidor), então lojas atrás de
// CDN/hosting compartilhado continuam funcionando normal. `redirect:
// "manual"` também fecha de graça uma variante do mesmo problema (a loja
// redirecionar pra um endereço interno) — a loja em si nunca deveria
// precisar redirecionar pra responder um endpoint JSON.
async function createPinnedFetch(hostname) {
  const { address, family } = await assertPublicHost(hostname);
  const dispatcher = new Agent({
    connect: {
      // O "Happy Eyeballs" do Node (autoSelectFamily, ligado por padrão)
      // chama o lookup pedindo TODOS os endereços de uma vez
      // (`options.all`) — sem tratar os dois formatos, o callback devolve
      // algo que o socket não entende e a conexão falha silenciosamente
      // ("Invalid IP address: undefined").
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) {
          callback(null, [{ address, family }]);
        } else {
          callback(null, address, family);
        }
      },
    },
  });
  return (url, options = {}) => fetch(url, { ...options, dispatcher, redirect: "manual" });
}

module.exports = { assertPublicHost, createPinnedFetch };
