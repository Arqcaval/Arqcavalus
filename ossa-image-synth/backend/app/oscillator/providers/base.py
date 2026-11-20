from __future__ import annotations

from dataclasses import dataclass, field


class ProviderError(Exception):
    def __init__(self, message: str, status: int = 0, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class UnsupportedOperation(ProviderError):
    pass


@dataclass
class ImageEditResult:
    image_bytes: bytes
    usage: dict = field(default_factory=dict)
    raw_meta: dict = field(default_factory=dict)


class ProviderAdapter:
    """Interface every provider adapter implements. Adapters must never fabricate output:
    unsupported operations raise UnsupportedOperation."""

    name = "base"
    label = "Base"

    def configured(self) -> bool:
        raise NotImplementedError

    def credential_hint(self) -> str:
        return ""

    def list_models(self) -> list[str]:
        raise NotImplementedError

    def image_edit(self, *, model: str, image_png: bytes, mask_png: bytes | None, prompt: str, size: str,
                   quality: str | None, input_fidelity: str | None) -> ImageEditResult:
        raise UnsupportedOperation(f"{self.name} does not support image editing")

    def image_analysis(self, *, model: str, image_png: bytes, prompt: str) -> str:
        raise UnsupportedOperation(f"{self.name} does not support image analysis")
