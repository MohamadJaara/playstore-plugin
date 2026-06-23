#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / ".codex-plugin" / "plugin.json"
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$")
HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)


def require_string(data: dict[str, Any], key: str, errors: list[str]) -> str | None:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        errors.append(f"`{key}` must be a non-empty string")
        return None
    return value


def main() -> int:
    errors: list[str] = []

    if not MANIFEST_PATH.is_file():
        fail(f"missing manifest at {MANIFEST_PATH.relative_to(ROOT)}")
        return 1

    raw = MANIFEST_PATH.read_text(encoding="utf-8")
    if "[TODO:" in raw:
        errors.append("manifest must not contain `[TODO: ...]` placeholders")

    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON in {MANIFEST_PATH.relative_to(ROOT)}: {exc}")
        return 1

    if not isinstance(manifest, dict):
        fail("manifest root must be a JSON object")
        return 1

    for key in ("name", "version", "description", "license", "skills"):
        require_string(manifest, key, errors)

    version = manifest.get("version")
    if isinstance(version, str) and not SEMVER.match(version):
        errors.append("`version` must be a semantic version like `0.1.0`")

    skills_ref = manifest.get("skills")
    if isinstance(skills_ref, str):
        skills_path = (ROOT / skills_ref).resolve()
        try:
            skills_path.relative_to(ROOT)
        except ValueError:
            errors.append("`skills` must resolve inside the repository")
        else:
            if not skills_path.is_dir():
                errors.append(f"`skills` path does not exist: {skills_ref}")
            elif not list(skills_path.glob("*/SKILL.md")):
                errors.append("`skills` path must contain at least one */SKILL.md file")

    author = manifest.get("author")
    if not isinstance(author, dict):
        errors.append("`author` must be an object")
    else:
        require_string(author, "name", errors)

    interface = manifest.get("interface")
    if not isinstance(interface, dict):
        errors.append("`interface` must be an object")
    else:
        for key in (
            "displayName",
            "shortDescription",
            "longDescription",
            "developerName",
            "category",
            "brandColor",
        ):
            require_string(interface, key, errors)

        brand_color = interface.get("brandColor")
        if isinstance(brand_color, str) and not HEX_COLOR.match(brand_color):
            errors.append("`interface.brandColor` must be a #RRGGBB hex color")

        capabilities = interface.get("capabilities")
        if not isinstance(capabilities, list) or not capabilities:
            errors.append("`interface.capabilities` must be a non-empty array")
        elif not all(isinstance(item, str) and item.strip() for item in capabilities):
            errors.append("`interface.capabilities` must contain only non-empty strings")

        default_prompt = interface.get("defaultPrompt")
        if not isinstance(default_prompt, list) or not default_prompt:
            errors.append("`interface.defaultPrompt` must be a non-empty array")
        elif not all(isinstance(item, str) and item.strip() for item in default_prompt):
            errors.append("`interface.defaultPrompt` must contain only non-empty strings")

    if errors:
        for error in errors:
            fail(error)
        return 1

    print("Plugin manifest validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
