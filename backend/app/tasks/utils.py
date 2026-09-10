import asyncio
import threading
from collections.abc import Coroutine
from typing import TypeVar

T = TypeVar("T")


def run_async(coro: Coroutine[None, None, T]) -> T:
    """
    Tarefas Celery são síncronas; os services usam httpx/Playwright async.

    Num worker Celery normal (processo separado, sem event loop rodando),
    `asyncio.run()` funciona direto. Mas no modo eager local (sem Redis —
    ver `celery_task_always_eager` em app/config.py), a task roda no mesmo
    thread do event loop do FastAPI, e `asyncio.run()` não pode ser chamado
    com um loop já em execução — por isso o fallback abaixo roda a coroutine
    numa thread separada com o próprio loop nesse caso.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    box: dict[str, object] = {}

    def _runner() -> None:
        try:
            box["result"] = asyncio.run(coro)
        except BaseException as exc:  # repropagada na thread chamadora abaixo
            box["error"] = exc

    thread = threading.Thread(target=_runner)
    thread.start()
    thread.join()

    if "error" in box:
        raise box["error"]  # type: ignore[misc]
    return box["result"]  # type: ignore[return-value]
