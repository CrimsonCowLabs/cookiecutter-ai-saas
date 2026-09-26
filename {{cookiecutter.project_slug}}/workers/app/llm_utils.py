"""LLM provider abstraction with rate limiting."""

from __future__ import annotations

import asyncio
import time
from typing import Any

from settings import settings


def get_llm() -> Any | None:
    """Factory function to create an LLM instance based on the configured provider.

    Supports:
    - "ollama": Local/cloud Ollama via OpenAI-compatible API
    - "openai": OpenAI API (GPT-4, etc.)
    - "anthropic": Anthropic API (Claude)
    - "openrouter": OpenRouter via OpenAI-compatible API

    Returns None if the required API key is not set.
    """
    provider = (settings.llm_provider or "ollama").lower()

    if provider == "openai":
        if not settings.openai_api_key:
            return None
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            api_key=settings.openai_api_key,
            model=settings.openai_model or "gpt-4o-mini",
            base_url=settings.openai_base_url,
            max_retries=5,
            request_timeout=120,
        )

    elif provider == "anthropic":
        if not settings.anthropic_api_key:
            return None
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(
            api_key=settings.anthropic_api_key,
            model=settings.anthropic_model or "claude-sonnet-4-20250514",
            max_retries=5,
            timeout=120,
        )

    elif provider == "openrouter":
        if not settings.openrouter_api_key:
            return None
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            api_key=settings.openrouter_api_key,
            model=settings.openrouter_model or "openai/gpt-4o-mini",
            base_url=settings.openrouter_base_url or "https://openrouter.ai/api/v1",
            max_retries=5,
            request_timeout=120,
        )

    else:  # ollama (default) — uses OpenAI-compatible API
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            api_key=settings.ollama_api_key or "ollama",
            model=settings.ollama_model or "llama3.2",
            base_url=settings.ollama_base_url or "http://localhost:11434/v1",
            max_retries=5,
            request_timeout=300,
        )


class LLMRateLimiter:
    """Coarse async rate limiter for LLM calls (rpm + concurrency)."""

    def __init__(self, rpm: int, max_concurrency: int) -> None:
        self.min_interval = 60.0 / max(rpm, 1)
        self._lock = asyncio.Lock()
        self._sem = asyncio.Semaphore(max(1, max_concurrency))
        self._next_time = 0.0

    async def acquire(self) -> None:
        await self._sem.acquire()
        try:
            async with self._lock:
                now = time.monotonic()
                wait = self._next_time - now
                if wait > 0:
                    await asyncio.sleep(wait)
                self._next_time = max(self._next_time, now) + self.min_interval
        except Exception:
            self._sem.release()
            raise

    def release(self) -> None:
        self._sem.release()


_limiter: LLMRateLimiter | None = None


def get_rate_limiter() -> LLMRateLimiter:
    global _limiter
    if _limiter is None:
        provider = (settings.llm_provider or "ollama").lower()
        if provider == "openai":
            rpm = settings.openai_rpm
            concurrency = settings.openai_max_concurrency
        elif provider == "anthropic":
            rpm = settings.anthropic_rpm
            concurrency = settings.anthropic_max_concurrency
        elif provider == "openrouter":
            rpm = settings.openrouter_rpm
            concurrency = settings.openrouter_max_concurrency
        else:
            rpm = settings.ollama_rpm
            concurrency = settings.ollama_max_concurrency
        _limiter = LLMRateLimiter(rpm=rpm, max_concurrency=concurrency)
    return _limiter
