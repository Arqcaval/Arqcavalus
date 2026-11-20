"""OpenAI adapter using the official REST API with an API key (never ChatGPT session cookies).

Endpoints used:
  GET  /v1/models              – discovery of models available to the configured key
  POST /v1/images/edits        – masked image editing
  POST /v1/chat/completions    – advisory image analysis (vision)
"""
from __future__ import annotations

import base64
import time

import httpx

from ...config import settings
from .base import ImageEditResult, ProviderAdapter, ProviderError


class OpenAIAdapter(ProviderAdapter):
    name = "openai"
    label = "OpenAI API"

    def __init__(self, api_key: str | None = None, base_url: str | None = None, transport: httpx.BaseTransport | None = None,
                 recorder=None):
        self._key = api_key if api_key is not None else settings.openai_api_key
        self.base_url = (base_url or settings.openai_base_url).rstrip("/")
        self.transport = transport
        self.recorder = recorder  # callable(operation, endpoint, model, request_summary, status, response_summary, ms)

    def configured(self) -> bool:
        return bool(self._key)

    def credential_hint(self) -> str:
        return ("Set OPENAI_API_KEY on the server (an API key from platform.openai.com). "
                "A ChatGPT subscription does not include API access.")

    def _client(self) -> httpx.Client:
        headers = {"Authorization": f"Bearer {self._key}"}
        if settings.openai_org:
            headers["OpenAI-Organization"] = settings.openai_org
        return httpx.Client(base_url=self.base_url, headers=headers, timeout=settings.provider_timeout_s,
                            transport=self.transport)

    def _record(self, *a):
        if self.recorder:
            self.recorder(*a)

    @staticmethod
    def _err(r: httpx.Response) -> ProviderError:
        try:
            body = r.json()
            msg = body.get("error", {}).get("message") or str(body)[:500]
        except Exception:
            msg = r.text[:500]
        return ProviderError(f"OpenAI API {r.status_code}: {msg}", status=r.status_code,
                             retryable=r.status_code in (429, 500, 502, 503, 504))

    def list_models(self) -> list[str]:
        if not self.configured():
            raise ProviderError("OpenAI API key not configured")
        t0 = time.time()
        with self._client() as c:
            try:
                r = c.get("/models")
            except httpx.HTTPError as e:
                self._record("list_models", "/models", "", {}, 0, {"error": str(e)}, int((time.time() - t0) * 1000))
                raise ProviderError(f"Could not reach OpenAI: {e}", retryable=True) from e
        ms = int((time.time() - t0) * 1000)
        if r.status_code != 200:
            self._record("list_models", "/models", "", {}, r.status_code, {"error": r.text[:300]}, ms)
            raise self._err(r)
        ids = sorted(m["id"] for m in r.json().get("data", []))
        self._record("list_models", "/models", "", {}, 200, {"count": len(ids)}, ms)
        return ids

    def image_edit(self, *, model, image_png, mask_png, prompt, size, quality, input_fidelity) -> ImageEditResult:
        if not self.configured():
            raise ProviderError("OpenAI API key not configured")
        data = {"model": model, "prompt": prompt, "n": "1", "size": size}
        if quality and quality != "standard":
            data["quality"] = quality
        if input_fidelity:
            data["input_fidelity"] = input_fidelity
        if model == "dall-e-2":
            data["response_format"] = "b64_json"
        files = [("image", ("source.png", image_png, "image/png"))]
        if mask_png is not None:
            files.append(("mask", ("mask.png", mask_png, "image/png")))
        summary = {k: v for k, v in data.items() if k != "prompt"}
        summary.update({"prompt_chars": len(prompt), "image_bytes": len(image_png), "mask_bytes": len(mask_png or b"")})
        t0 = time.time()
        with self._client() as c:
            try:
                r = c.post("/images/edits", data=data, files=files)
            except httpx.HTTPError as e:
                self._record("image_edit", "/images/edits", model, summary, 0, {"error": str(e)}, int((time.time() - t0) * 1000))
                raise ProviderError(f"Request to OpenAI failed: {e}", retryable=True) from e
        ms = int((time.time() - t0) * 1000)
        if r.status_code != 200:
            self._record("image_edit", "/images/edits", model, summary, r.status_code, {"error": r.text[:500]}, ms)
            raise self._err(r)
        body = r.json()
        items = body.get("data") or []
        if not items or not items[0].get("b64_json"):
            self._record("image_edit", "/images/edits", model, summary, r.status_code, {"error": "no image in response"}, ms)
            raise ProviderError("OpenAI returned no image data")
        img = base64.b64decode(items[0]["b64_json"])
        usage = body.get("usage") or {}
        self._record("image_edit", "/images/edits", model, summary, 200,
                     {"usage": usage, "output_bytes": len(img), "revised_prompt": bool(items[0].get("revised_prompt"))}, ms)
        return ImageEditResult(image_bytes=img, usage=usage, raw_meta={"created": body.get("created")})

    def image_analysis(self, *, model, image_png, prompt) -> str:
        if not self.configured():
            raise ProviderError("OpenAI API key not configured")
        b64 = base64.b64encode(image_png).decode()
        payload = {"model": model, "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}],
            "max_completion_tokens": 1500}
        t0 = time.time()
        with self._client() as c:
            try:
                r = c.post("/chat/completions", json=payload)
            except httpx.HTTPError as e:
                raise ProviderError(f"Request to OpenAI failed: {e}", retryable=True) from e
        ms = int((time.time() - t0) * 1000)
        summary = {"model": model, "prompt_chars": len(prompt), "image_bytes": len(image_png)}
        if r.status_code != 200:
            self._record("image_analysis", "/chat/completions", model, summary, r.status_code, {"error": r.text[:500]}, ms)
            raise self._err(r)
        body = r.json()
        text = body["choices"][0]["message"].get("content") or ""
        self._record("image_analysis", "/chat/completions", model, summary, 200, {"usage": body.get("usage", {})}, ms)
        return text
