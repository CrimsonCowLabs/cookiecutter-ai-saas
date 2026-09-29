"""Application settings loaded from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


_TRUTHY = {"1", "true", "yes", "on"}


def _env(key: str, default: str | None = None) -> str | None:
    value = os.getenv(key)
    if value is None or value == "":
        return default
    return value


def _flag(key: str, default: bool = False) -> bool:
    """A boolean switch. Unset or empty means `default`; anything unrecognized is off."""
    value = _env(key)
    if value is None:
        return default
    return value.strip().lower() in _TRUTHY


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

    # Upper bound on tool calls the AI step's agent may make in one job. The
    # graph recursion limit is derived from it as a backstop.
    research_max_tool_calls: int = int(_env("RESEARCH_MAX_TOOL_CALLS", "8") or "8")

    # LangSmith tracing. Opt-in and off by default: see `tracing.py`, which owns
    # every LangSmith environment variable the SDK reads. Enabling it ships
    # prompts and completions to the configured collector.
    langsmith_tracing: bool = _flag("LANGSMITH_TRACING")
    langsmith_api_key: str | None = _env("LANGSMITH_API_KEY")
    # Empty means the hosted collector; set it to a self-hosted LangSmith.
    langsmith_endpoint: str | None = _env("LANGSMITH_ENDPOINT")
    langsmith_project: str | None = _env("LANGSMITH_PROJECT")

    # Redis
    redis_url: str = _env("REDIS_URL", "redis://localhost:6379") or "redis://localhost:6379"


settings = Settings()
