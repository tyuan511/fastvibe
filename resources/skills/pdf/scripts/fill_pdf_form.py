#!/usr/bin/env python3
"""按字段名填写一个可填字段的 PDF 表单。

先跑 list_pdf_fields.py 拿到准确的字段名——那是程序用的标识，不是界面上的标签。

用法：
    python3 fill_pdf_form.py input.pdf values.json output.pdf

values.json 形如：
    {
      "name": "张三",
      "agree": true,
      "gender": "Male",
      "date": "2026-01-01"
    }

值怎么给：
  文本字段   直接给字符串
  复选框     给 true / false（会写成 PDF 里该字段自己的开状态，通常是 /Yes）
  单选组     给选项名（list_pdf_fields.py 的「可选状态」里那一个）
  下拉       给选项文本

注意：填完之后字段内容是否显示，取决于 PDF 自己的外观流（/AP）。有些 PDF 由阅读器
在打开时渲染字段值，命令行里看不到变化——所以填完一定要渲染成图片看一眼。
"""

from __future__ import annotations

import argparse
import json
import sys

try:
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject
except ImportError:
    print("需要 pypdf：pip install pypdf", file=sys.stderr)
    sys.exit(2)


def field_states(info: dict) -> list[str]:
    """该字段（按钮类）可用的非 Off 状态名。"""
    states: list[str] = []

    def walk(node: object) -> None:
        if not isinstance(node, dict):
            return
        appearance = node.get("/AP")
        if isinstance(appearance, dict):
            normal = appearance.get("/N")
            if isinstance(normal, dict):
                for key in normal:
                    text = str(key)
                    if text != "/Off" and text not in states:
                        states.append(text)

    walk(info)
    return states


def coerce(info: dict, value: object) -> object:
    """把一个 JSON 值转成 PDF 字段能接受的形式。"""
    kind = str(info.get("/FT", "")).lstrip("/")

    if kind == "Btn":
        if isinstance(value, bool):
            states = field_states(info)
            # 复选框的开状态几乎总是 /Yes，但 PDF 里可以是任意名字，所以先问过字段自己。
            on = states[0] if states else "Yes"
            return NameObject(f"/{on}") if value else NameObject("/Off")
        # 允许直接给状态名（单选组就是这么用的）
        return NameObject(f"/{str(value).lstrip('/')}")

    if isinstance(value, bool):
        return "Yes" if value else "Off"
    return str(value)


def main() -> None:
    parser = argparse.ArgumentParser(description="填写 PDF 表单")
    parser.add_argument("pdf", help="输入 PDF")
    parser.add_argument("values", help="JSON 文件：字段名到值的映射")
    parser.add_argument("output", help="输出 PDF")
    args = parser.parse_args()

    try:
        with open(args.values, encoding="utf-8") as handle:
            values = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        print(f"读不了 values 文件：{error}", file=sys.stderr)
        sys.exit(1)

    if not isinstance(values, dict):
        print("values 文件必须是一个 JSON 对象：{字段名: 值}", file=sys.stderr)
        sys.exit(1)

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

    if not fields:
        print("这个 PDF 没有可填字段，请改用坐标叠加：", file=sys.stderr)
        print("  python3 add_pdf_text.py in.pdf out.pdf \"72,700,文本\"", file=sys.stderr)
        sys.exit(1)

    unknown = [name for name in values if name not in fields]
    if unknown:
        # 字段名写错是这里最常见的失败，而且 pypdf 会静默忽略，所以必须自己拦。
        print(f"这些字段名在 PDF 里不存在：{', '.join(unknown)}", file=sys.stderr)
        print("跑 list_pdf_fields.py 看准确的字段名。", file=sys.stderr)
        print(f"可用的字段：{', '.join(fields)}", file=sys.stderr)
        sys.exit(1)

    writer = PdfWriter()
    writer.append(reader)

    # 用 update_page_form_field_values 而不是自己改 /V：它会同时处理
    # NeedAppearances 和字段的继承链，自己改会得到「值存进去了但不显示」的结果。
    coerced = {name: coerce(fields[name], value) for name, value in values.items()}
    for page in writer.pages:
        try:
            writer.update_page_form_field_values(page, coerced, auto_regenerate=False)
        except Exception:  # noqa: BLE001 - 某一页没有这些字段是正常的
            continue

    # 让阅读器自己重算外观流。不设这个的话，很多查看器打开是空白的。
    try:
        writer.set_need_appearances_writer(True)
    except Exception:  # noqa: BLE001 - 老版本 pypdf 没这个方法，不是致命问题
        pass

    with open(args.output, "wb") as handle:
        writer.write(handle)

    # 中文能不能显示，取决于这个表单自己的字体编码。很多表单用 Helvetica（WinAnsi），
    # 写中文进去会静默变成乱码或空白——值确实存进去了，但看不见。
    if any(isinstance(value, str) and any(ord(ch) > 255 for ch in value) for value in coerced.values()):
        print(
            "提醒：有中文（或其他非拉丁字符）值。若原表单用的是 Helvetica 这类内置字体，"
            "中文可能显示不出来——先渲染一页确认；不行就得改字体或改用坐标叠加。",
            file=sys.stderr,
        )

    print(f"已写入 {args.output}（填了 {len(coerced)} 个字段）")
    print("请渲染一页确认内容真的显示出来了——有些 PDF 的外观流不会自动更新。")


if __name__ == "__main__":
    main()
