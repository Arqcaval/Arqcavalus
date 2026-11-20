from __future__ import annotations

import datetime as dt

from sqlalchemy import inspect

HIDDEN = {"password_hash", "token_hash"}


def ser(obj, exclude: set[str] | None = None) -> dict:
    if obj is None:
        return None
    out = {}
    for c in inspect(obj).mapper.column_attrs:
        k = c.key
        if k in HIDDEN or (exclude and k in exclude):
            continue
        v = getattr(obj, k)
        if isinstance(v, dt.datetime):
            v = v.isoformat() + "Z"
        out[k] = v
    return out
