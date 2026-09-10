// Número do WhatsApp do suporte (+55 61 9925-3506).
const SUPPORT_WHATSAPP_NUMBER = '556199253506'

// Mensagem já preenchida quando a pessoa clica — só precisa apertar
// enviar. Identifica que veio do app (o atendente já sabe o contexto) sem
// ser longa demais pra ler no celular.
const SUPPORT_MESSAGE = 'Olá! Sou cliente do ScoutX e preciso de ajuda.'

function whatsappUrl(number, message) {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`
}

// Glifo oficial do WhatsApp (silhueta do telefone dentro do balão) — sem
// isso era só um ícone genérico de "balão de chat" do lucide-react, que
// não identifica a marca de cara.
function WhatsAppIcon({ size = 24, className = '' }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} fill="currentColor" aria-hidden="true">
      <path d="M16.004 2.667c-7.363 0-13.333 5.97-13.333 13.333 0 2.351.616 4.646 1.786 6.666L2.667 29.333l6.84-1.794a13.27 13.27 0 0 0 6.497 1.694h.006c7.362 0 13.333-5.97 13.333-13.333 0-3.56-1.387-6.907-3.905-9.425a13.24 13.24 0 0 0-9.428-3.808Zm0 24.4h-.005a11.06 11.06 0 0 1-5.64-1.545l-.404-.24-4.06 1.065 1.084-3.958-.264-.407a11.05 11.05 0 0 1-1.692-5.882c0-6.114 4.976-11.09 11.086-11.09a11.02 11.02 0 0 1 7.842 3.253 11.02 11.02 0 0 1 3.246 7.847c-.003 6.114-4.978 11.09-11.09 11.09h-.103Zm6.083-8.303c-.334-.167-1.97-.972-2.275-1.083-.305-.112-.527-.167-.75.166-.222.334-.861 1.084-1.055 1.306-.194.223-.389.25-.722.084-.334-.167-1.408-.519-2.682-1.654-.992-.885-1.663-1.978-1.857-2.312-.194-.334-.02-.514.146-.68.15-.15.334-.39.5-.585.167-.195.223-.334.334-.556.111-.223.056-.417-.028-.584-.083-.167-.75-1.807-1.027-2.474-.27-.65-.545-.562-.75-.573l-.639-.011c-.222 0-.583.083-.889.417-.305.334-1.166 1.14-1.166 2.78 0 1.641 1.194 3.226 1.361 3.448.167.223 2.351 3.591 5.696 5.036.796.344 1.417.549 1.9.702.798.254 1.526.218 2.101.132.641-.096 1.97-.806 2.248-1.585.278-.778.278-1.446.194-1.585-.083-.14-.305-.223-.639-.39Z" />
    </svg>
  )
}

export default function Suporte() {
  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Suporte</h2>
        <p className="text-sm text-[var(--text-muted)]">Precisa de ajuda? Fale direto com a gente.</p>
      </div>

      <div className="relative overflow-hidden rounded-3xl border border-emerald-500/20 bg-[var(--bg-surface)] p-8 text-center sm:p-10">
        {/* Grade sutil + glow, mesma linguagem visual das telas de
            login/registro (server.js authPage) — reforça identidade em vez
            de um card genérico. */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.12]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(16,185,129,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(16,185,129,0.5) 1px, transparent 1px)',
            backgroundSize: '34px 34px',
            maskImage: 'radial-gradient(ellipse 80% 70% at 50% 30%, #000 40%, transparent 100%)',
            WebkitMaskImage: 'radial-gradient(ellipse 80% 70% at 50% 30%, #000 40%, transparent 100%)',
          }}
        />
        <div className="pointer-events-none absolute left-1/2 top-0 h-72 w-72 -translate-x-1/2 -translate-y-1/3 rounded-full bg-emerald-500/25 blur-3xl" />

        <div className="relative">
          {/* Badge com anel pulsando por trás — sensação de "ao vivo",
              sem afirmar status de atendimento que a gente não controla
              de verdade (não é um indicador de "online" literal). */}
          <div className="relative mx-auto flex h-20 w-20 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-3xl bg-emerald-500/30" style={{ animationDuration: '2.5s' }} />
            <span className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-lg shadow-emerald-600/40">
              <WhatsAppIcon size={38} />
            </span>
          </div>

          <h3 className="mt-6 text-lg font-semibold text-[var(--text-primary)]">Fale com o suporte no WhatsApp</h3>
          <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--text-muted)]">
            Dúvida, problema ou sugestão — manda mensagem que a gente responde por lá, direto com o time.
          </p>

          <a
            href={whatsappUrl(SUPPORT_WHATSAPP_NUMBER, SUPPORT_MESSAGE)}
            target="_blank"
            rel="noopener noreferrer"
            className="group mt-7 inline-flex items-center gap-2.5 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600 px-7 py-3.5 text-sm font-semibold text-white shadow-xl shadow-emerald-600/30 transition-all hover:scale-[1.03] hover:shadow-emerald-600/50 hover:from-emerald-400 hover:to-emerald-500"
          >
            <WhatsAppIcon size={18} className="transition-transform group-hover:rotate-[8deg]" />
            Abrir WhatsApp
          </a>
        </div>
      </div>
    </div>
  )
}
