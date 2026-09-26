"""Application settings loaded from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _env(key: str, default: str | None = None) -> str | None:
    value = os.getenv(key)
    if value is None or value == "":
        return default
    return value


@dataclass(frozen=True)
class Settings:
    """Centralized, dotenv-backed settings."""

    # LLM provider selection: "ollama", "openai", "anthropic", or "openrouter"
    llm_provider: str = _env("LLM_PROVIDER", "ollama") or "ollama"

    # OpenAI settings
    openai_api_key: str | None = _env("OPENAI_API_KEY")
    openai_model: str | None = _env("OPENAI_MODEL")
    openai_base_url: str | None = _env("OPENAI_BASE_URL")
    openai_rpm: int = int(_env("OPENAI_RPM", "10") or "10")
    openai_max_concurrency: int = int(_env("OPENAI_MAX_CONCURRENCY", "2") or "2")

    # Ollama settings (uses OpenAI-compatible API)
    ollama_api_key: str | None = _env("OLLAMA_API_KEY")
    ollama_base_url: str | None = _env("OLLAMA_BASE_URL", "http://localhost:11434/v1")
    ollama_model: str | None = _env("OLLAMA_MODEL", "llama3.2")
    ollama_rpm: int = int(_env("OLLAMA_RPM", "30") or "30")
    ollama_max_concurrency: int = int(_env("OLLAMA_MAX_CONCURRENCY", "4") or "4")

    # Anthropic settings
    anthropic_api_key: str | None = _env("ANTHROPIC_API_KEY")
    anthropic_model: str | None = _env("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
    anthropic_rpm: int = int(_env("ANTHROPIC_RPM", "10") or "10")
    anthropic_max_concurrency: int = int(_env("ANTHROPIC_MAX_CONCURRENCY", "2") or "2")

    # OpenRouter settings (uses OpenAI-compatible API)
    openrouter_api_key: str | None = _env("OPENROUTER_API_KEY")
    openrouter_model: str | None = _env("OPENROUTER_MODEL", "openai/gpt-4o-mini")
    openrouter_base_url: str | None = _env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    openrouter_rpm: int = int(_env("OPENROUTER_RPM", "20") or "20")
    openrouter_max_concurrency: int = int(_env("OPENROUTER_MAX_CONCURRENCY", "4") or "4")

    # Redis
    redis_url: str = _env("REDIS_URL", "redis://localhost:6379") or "redis://localhost:6379"


settings = Settings()
