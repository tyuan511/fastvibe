#!/usr/bin/env python3
"""列出一个 PDF 表单的字段：名字、类型、当前值、可选项。

填表单前必须跑一次：字段名是程序用的标识，往往和界面上看到的标签不一样
（界面上写「姓名」，字段名可能是 `topmostSubform[0].Page1[0].name[0]`）。

用法：
    python3 list_pdf_fields.py input.pdf [--json]
"""

from __future__ import annotations

import argparse
import json
import sys

try:
    from pypdf import PdfReader
except ImportError:
    print("需要 pypdf：pip install pypdf", file=sys.stderr)
    sys.exit(2)

# /FT 的类型码到人话
TYPE_LABELS = {
    "Tx": "文本",
    "Btn": "按钮/复选框/单选",
    "Ch": "下拉/列表",
    "Sig": "签名",
}


def describe(info: dict) -> dict:
    kind = str(info.get("/FT", "")).lstrip("/")
    entry: dict = {"type": kind or "unknown", "label": TYPE_LABELS.get(kind, kind or "未知")}

    value = info.get("/V")
    if value is not None:
        entry["value"] = str(value)

    # 默认值：表单还没填过时它常是模板里预置的内容
    default = info.get("/DV")
    if default is not None:
        entry["default"] = str(default)

    # 复选框/单选：/AP 里的键（/Off、/Yes…）就是它的可选状态
    if kind == "Btn":
        states = states_of(info)
        if states:
            entry["states"] = states

    # 下拉/列表：/Opt 是选项
    if kind == "Ch":
        options = info.get("/Opt")
        if options:
            entry["options"] = [str(item) for item in options]

    flags = info.get("/Ff")
    if flags is not None:
        try:
            bits = int(flags)
            if kind == "Tx" and bits & (1 << 12):
                entry["multiline"] = True
            if kind == "Tx" and bits & (1 << 13):
                entry["password"] = True
        except (TypeError, ValueError):
            pass
    return entry


def states_of(info: dict) -> list[str]:
    """复选框或单选组有哪些状态。递归找 /AP 的 /N 子字典的键。"""
    found: list[str] = []

    def walk(node: object) -> None:
        if not isinstance(node, dict):
            return
        appearance = node.get("/AP")
        if isinstance(appearance, dict):
            normal = appearance.get("/N")
            if isinstance(normal, dict):
                for key in normal:
                    text = str(key)
                    if text != "/Off" and text not in found:
                        found.append(text)

    walk(info)
    return found


def main() -> None:
    parser = argparse.ArgumentParser(description="列出 PDF 表单字段")
    parser.add_argument("pdf", help="要检查的 PDF")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    try:
        reader = PdfReader(args.pdf)
    except Exception as error:  # noqa: BLE001
        print(f"打不开这个文件：{error}", file=sys.stderr)
        sys.exit(1)

    if reader.is_encrypted:
        print("这个文件是加密的，先解密：qpdf --password=口令 --decrypt in.pdf out.pdf", file=sys.stderr)
        sys.exit(1)

    try:
        fields = reader.get_fields() or {}
    except Exception as error:  # noqa: BLE001
        print(f"读取字段失败：{error}", file=sys.stderr)
        sys.exit(1)

    described = {name: describe(info) for name, info in fields.items()}

    if args.json:
        print(json.dumps(described, ensure_ascii=False, indent=2))
        return

    if not described:
        print("没有可填字段。这是一个扁平表单，走坐标叠加那条路：")
        print("  python3 add_pdf_text.py in.pdf out.pdf \"72,700,文本\"")
        return

    print(f"共 {len(described)} 个字段：\n")
    for name, entry in described.items():
        print(f"  {name}")
        print(f"    类型: {entry['label']}")
        if "value" in entry:
            print(f"    当前值: {entry['value']}")
        if "states" in entry:
            print(f"    可选状态: {', '.join(entry['states'])}")
        if "options" in entry:
            print(f"    选项: {', '.join(entry['options'])}")
        if entry.get("multiline"):
            print("    多行文本")
    print("\n按上面的字段名写 values.json，然后：")
    print("  python3 fill_pdf_form.py input.pdf values.json output.pdf")


if __name__ == "__main__":
    main()
