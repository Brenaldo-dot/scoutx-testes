from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg2://intel:change-me@localhost:5432/competitor_intel"
    redis_url: str = "redis://localhost:6379/0"

    # Só pra rodar local sem Docker/Redis/worker (ver backend/run_local.sh):
    # faz .delay() executar a task na hora, dentro da própria requisição, em
    # vez de enfileirar. Nunca deve ser true no docker-compose/produção — lá
    # o Celery worker + beat real é que devem processar as tasks.
    celery_task_always_eager: bool = False

    telegram_bot_token: str = ""
    telegram_chat_id: str = ""

    # Canal de notificação em uso (Módulo 7) — Discord Webhook, mais simples
    # que o bot do Telegram (não exige token de bot + chat_id + iniciar
    # conversa, só a URL do webhook do canal). discord_mention_id é opcional:
    # ID numérico (Discord snowflake) de usuário pra marcar com @ na
    # mensagem, ou o literal "everyone" pra marcar @everyone — sem isso, o
    # webhook posta no canal sem notificar ninguém especificamente.
    discord_webhook_url: str = ""
    discord_mention_id: str = ""

    # Scraping etiquette. These exist to spread daily load across many stores
    # reliably (avoid tripping per-IP rate limits), not to defeat anti-bot
    # defenses or reach non-public/authenticated areas of a site.
    scraper_proxies: str = ""  # comma-separated http proxy URLs
    scraper_request_delay_seconds: float = 1.5
    scraper_user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )

    frontend_origin: str = "http://localhost:5173"

    # Revisão de segurança (Módulo 9): o proxy Node manda X-User-Id/
    # X-User-Is-Admin sem assinatura nenhuma (api/deps.py) — até agora a
    # única proteção era esse serviço não ter domínio público, o que se
    # mostrou frágil. Esse segredo compartilhado (mesmo valor configurado no
    # Node) é a segunda camada: requisição sem ele (ou com valor errado) é
    # rejeitada quando essa variável está configurada. Vazio por padrão só
    # pra não quebrar `run_local.sh` (sem Node na frente em dev local) — em
    # produção sempre deve vir preenchida.
    internal_api_secret: str = ""

    @property
    def proxy_list(self) -> list[str]:
        return [p.strip() for p in self.scraper_proxies.split(",") if p.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
