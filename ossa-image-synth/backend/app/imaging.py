"""Pixel-level operations: masks, provider image preparation, compositing and verification.

Mask convention (stored PNGs, mode "L", same size as the source):
  edit mask      255 = region the AI is authorised to change
  protected mask 255 = region that must not change, even inside the edit mask
"""
from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageFilter

PROVIDER_SIZES = {(1024, 1024): "1024x1024", (1536, 1024): "1536x1024", (1024, 1536): "1024x1536"}


def load_rgb(data: bytes) -> Image.Image:
    with Image.open(io.BytesIO(data)) as im:
        return im.convert("RGB").copy()


def load_mask(data: bytes, size: tuple[int, int]) -> np.ndarray:
    """Returns a boolean array (H, W). Accepts L/RGB/RGBA PNGs; RGBA masks use alpha>0 or white."""
    with Image.open(io.BytesIO(data)) as im:
        if im.size != size:
            raise ValueError(f"mask size {im.size} does not match image size {size}")
        if im.mode in ("RGBA", "LA"):
            a = np.asarray(im.getchannel("A"))
            l = np.asarray(im.convert("L"))
            return (a > 127) & (l > 127)
        return np.asarray(im.convert("L")) > 127


def mask_to_png(mask: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray((mask.astype(np.uint8) * 255), "L").save(buf, "PNG")
    return buf.getvalue()


def to_png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def effective_edit_region(size: tuple[int, int], edit: np.ndarray | None, protected: np.ndarray | None, scope: str) -> np.ndarray:
    w, h = size
    if scope == "global":
        region = np.ones((h, w), dtype=bool)
    else:
        if edit is None:
            raise ValueError("local edits require an explicit edit mask")
        region = edit.copy()
    if protected is not None:
        region &= ~protected
    return region


@dataclass
class Prepared:
    image_png: bytes
    mask_png: bytes  # RGBA, alpha 0 = editable (OpenAI convention)
    size_label: str
    scale: float
    pad: tuple[int, int, int, int]  # left, top, right, bottom in provider pixels
    provider_size: tuple[int, int]


def choose_provider_size(w: int, h: int, sizes: list[str]) -> tuple[int, int]:
    options = []
    for s in sizes:
        if "x" not in s:
            continue
        a, b = (int(x) for x in s.split("x"))
        options.append((a, b))
    if not options:
        options = [(1024, 1024)]
    ratio = w / h
    return min(options, key=lambda o: abs(np.log((o[0] / o[1]) / ratio)))


def prepare_for_provider(src: Image.Image, region: np.ndarray, sizes: list[str]) -> Prepared:
    """Uniformly scale + pad (never stretch) the source to a provider-supported size, so the
    provider output can be mapped back onto the original geometry exactly."""
    w, h = src.size
    pw, ph = choose_provider_size(w, h, sizes)
    scale = min(pw / w, ph / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    left, top = (pw - nw) // 2, (ph - nh) // 2
    canvas = Image.new("RGB", (pw, ph), (0, 0, 0))
    canvas.paste(src.resize((nw, nh), Image.LANCZOS), (left, top))
    m = Image.fromarray(region.astype(np.uint8) * 255, "L").resize((nw, nh), Image.NEAREST)
    mfull = Image.new("L", (pw, ph), 0)
    mfull.paste(m, (left, top))
    alpha = Image.eval(mfull, lambda v: 0 if v > 127 else 255)  # transparent where editable
    rgba = canvas.convert("RGBA")
    rgba.putalpha(alpha)
    return Prepared(image_png=to_png(canvas), mask_png=to_png(rgba), size_label=f"{pw}x{ph}", scale=scale,
                    pad=(left, top, pw - left - nw, ph - top - nh), provider_size=(pw, ph))


def restore_from_provider(out: Image.Image, prep: Prepared, target: tuple[int, int]) -> Image.Image:
    pw, ph = prep.provider_size
    if out.size != (pw, ph):
        out = out.resize((pw, ph), Image.LANCZOS)
    l, t, r, b = prep.pad
    out = out.crop((l, t, pw - r, ph - b))
    return out.resize(target, Image.LANCZOS)


def composite(src: Image.Image, gen: Image.Image, region: np.ndarray, feather_px: float = 1.5) -> Image.Image:
    """Keep original pixels outside `region` bit-exactly. Feathering is applied only inward."""
    if gen.size != src.size:
        raise ValueError("generated image must be restored to source size before compositing")
    a = region.astype(np.float32)
    if feather_px > 0:
        blurred = np.asarray(Image.fromarray((a * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(feather_px)),
                             dtype=np.float32) / 255.0
        a = np.minimum(blurred * 2.0, 1.0) * a  # inward-only: zero outside the region
    s = np.asarray(src, dtype=np.float32)
    g = np.asarray(gen, dtype=np.float32)
    out = s * (1 - a[..., None]) + g * a[..., None]
    out = np.where(region[..., None], np.clip(np.rint(out), 0, 255), s).astype(np.uint8)
    return Image.fromarray(out, "RGB")


def change_stats(src: Image.Image, out: Image.Image, region: np.ndarray | None, tol: int) -> dict:
    s = np.asarray(src, dtype=np.int16)
    o = np.asarray(out, dtype=np.int16)
    d = np.abs(s - o).max(axis=2)
    total = d.size
    if region is None:
        region = np.zeros(d.shape, dtype=bool)
    outside = ~region
    n_out = int(outside.sum())
    n_in = int(region.sum())
    changed_out = int((d[outside] > tol).sum()) if n_out else 0
    changed_in = int((d[region] > tol).sum()) if n_in else 0
    return {
        "pixels_total": int(total),
        "pixels_outside": n_out,
        "pixels_inside": n_in,
        "changed_outside": changed_out,
        "changed_outside_pct": round(100 * changed_out / n_out, 4) if n_out else 0.0,
        "max_diff_outside": int(d[outside].max()) if n_out else 0,
        "changed_inside": changed_in,
        "changed_inside_pct": round(100 * changed_in / n_in, 3) if n_in else 0.0,
        "mean_diff_inside": round(float(d[region].mean()), 3) if n_in else 0.0,
        "tolerance": tol,
    }


def diff_image(src: Image.Image, out: Image.Image, gain: float = 4.0) -> Image.Image:
    s = np.asarray(src, dtype=np.int16)
    o = np.asarray(out, dtype=np.int16)
    d = np.clip(np.abs(s - o).max(axis=2) * gain, 0, 255).astype(np.uint8)
    heat = np.zeros((*d.shape, 3), dtype=np.uint8)
    heat[..., 0] = d
    heat[..., 1] = (d * 0.35).astype(np.uint8)
    base = (np.asarray(src.convert("L"), dtype=np.float32) * 0.25).astype(np.uint8)
    rgb = np.maximum(np.stack([base] * 3, axis=2), heat)
    return Image.fromarray(rgb, "RGB")


def mask_overlay(src: Image.Image, region: np.ndarray, protected: np.ndarray | None) -> Image.Image:
    s = np.asarray(src, dtype=np.float32).copy()
    s[region] = s[region] * 0.55 + np.array([40, 200, 120]) * 0.45
    if protected is not None:
        s[protected] = s[protected] * 0.55 + np.array([230, 60, 60]) * 0.45
    return Image.fromarray(np.clip(s, 0, 255).astype(np.uint8), "RGB")
