"""Test doubles shared by agent tests."""

from __future__ import annotations

from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field, PrivateAttr


class ScriptedChatModel(BaseChatModel):
    """Chat model that replays a fixed list of AI messages, one per call.

    Needs no provider key and no network. `seen` records the messages of every
    call and `bound_tool_names` the tools the agent offered, so tests can assert
    on what the model was actually shown.
    """

    responses: list[AIMessage]
    seen: list[list[BaseMessage]] = Field(default_factory=list)
    bound_tool_names: list[str] = Field(default_factory=list)
    _next: int = PrivateAttr(default=0)

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> ScriptedChatModel:
        # Deliberately mutates self: the agent binds once and calls the bound
        # model, and the tests want to read the binding back.
        for tool in tools:
            name = tool.get("name") if isinstance(tool, dict) else getattr(tool, "name", None)
            self.bound_tool_names.append(name or getattr(tool, "__name__", str(tool)))
        return self

    def _generate(self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs: Any) -> ChatResult:
        self.seen.append(list(messages))
        if self._next >= len(self.responses):
            raise AssertionError("ScriptedChatModel ran out of scripted responses")
        message = self.responses[self._next]
        self._next += 1
        return ChatResult(generations=[ChatGeneration(message=message)])


def tool_call_message(name: str, args: dict, call_id: str = "call-1") -> AIMessage:
    """An AI message that asks for one tool call."""
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def fake_fetcher(
    body: str = "<html><head><title>Example</title></head><body><p>Hello.</p></body></html>",
    *,
    content_type: str = "text/html",
    url: str = "https://example.com/article",
):
    """A blocking `str -> RawResponse` fetcher that never touches the network."""
    from tools.fetch_url import RawResponse

    def fetch(requested: str) -> RawResponse:
        return RawResponse(url=url or requested, content_type=content_type, body=body)

    return fetch


class FakeHTTPResponse:
    """The minimum `tools.fetch_url.http_get` needs from an opened response."""

    def __init__(self, status: int = 200, headers: dict | None = None, body: bytes = b"") -> None:
        self.status = status
        self.headers = headers if headers is not None else {"Content-Type": "text/html"}
        self._body = body
        self.closed = False

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            chunk, self._body = self._body, b""
            return chunk
        chunk, self._body = self._body[:size], self._body[size:]
        return chunk

    def close(self) -> None:
        self.closed = True


def public_resolver(address: str = "93.184.216.34"):
    """A `socket.getaddrinfo` stand-in that resolves every host to `address`."""
    import socket

    def resolve(host, port, **kwargs):
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        return [(family, socket.SOCK_STREAM, 6, "", (address, port))]

    return resolve
