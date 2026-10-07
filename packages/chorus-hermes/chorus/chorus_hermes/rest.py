"""Chorus REST client for ``/api/daemon/*`` and friends.

Every Chorus REST route answers ``{"success": true, "data": ...}`` or
``{"success": false, "error": "..."}``; :func:`unwrap` turns that envelope into
``data`` or a :class:`ChorusRestError`.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

import httpx

from .config import ChorusConfig

DEFAULT_TIMEOUT = 20.0


class ChorusRestError(RuntimeError):
    def __init__(self, status: int, message: str, path: str = ""):
        super().__init__(f"Chorus REST {path or '<request>'} failed ({status}): {message}")
        self.status = status
        self.message = message
        self.path = path


def unwrap(response: httpx.Response, path: str = "") -> Any:
    """Return the envelope's ``data`` (``None`` for an empty 2xx body)."""
    body: Any = None
    if response.content:
        try:
            body = response.json()
        except ValueError:
            body = None
    if response.status_code >= 400:
        message = body.get("error") if isinstance(body, dict) else None
        raise ChorusRestError(response.status_code, str(message or response.reason_phrase or "error"), path)
    if body is None:
        return None
    if not isinstance(body, dict) or "success" not in body:
        raise ChorusRestError(response.status_code, "response is not a {success,data} envelope", path)
    if body.get("success") is not True:
        raise ChorusRestError(response.status_code, str(body.get("error") or "unknown error"), path)
    return body.get("data")


class ChorusRest:
    def __init__(self, cfg: ChorusConfig, *, transport: Optional[httpx.BaseTransport] = None,
                 async_transport: Optional[httpx.AsyncBaseTransport] = None,
                 timeout: float = DEFAULT_TIMEOUT):
        self.cfg = cfg
        self._transport = transport
        self._async_transport = async_transport
        self._timeout = timeout

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.cfg.api_key}", "Accept": "application/json"}

    def _url(self, path: str) -> str:
        return f"{self.cfg.url}/{path.lstrip('/')}"

    def request(self, method: str, path: str, *, json: Any = None,
                params: Optional[Mapping[str, Any]] = None) -> Any:
        try:
            with httpx.Client(transport=self._transport, timeout=self._timeout) as client:
                response = client.request(method, self._url(path), json=json, params=params,
                                          headers=self._headers())
        except httpx.HTTPError as exc:
            raise ChorusRestError(0, f"request failed: {type(exc).__name__}", path) from exc
        return unwrap(response, path)

    async def arequest(self, method: str, path: str, *, json: Any = None,
                       params: Optional[Mapping[str, Any]] = None) -> Any:
        try:
            async with httpx.AsyncClient(transport=self._async_transport, timeout=self._timeout) as client:
                response = await client.request(method, self._url(path), json=json, params=params,
                                                headers=self._headers())
        except httpx.HTTPError as exc:
            raise ChorusRestError(0, f"request failed: {type(exc).__name__}", path) from exc
        return unwrap(response, path)

    def get(self, path: str, **kw) -> Any:
        return self.request("GET", path, **kw)

    def post(self, path: str, body: Any = None, **kw) -> Any:
        return self.request("POST", path, json=body, **kw)

    async def aget(self, path: str, **kw) -> Any:
        return await self.arequest("GET", path, **kw)

    async def apost(self, path: str, body: Any = None, **kw) -> Any:
        return await self.arequest("POST", path, json=body, **kw)
