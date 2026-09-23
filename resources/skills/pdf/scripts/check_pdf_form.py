#!/usr/bin/env python3
"""判断一个 PDF 的表单属于哪一类，并说明下一步该走哪条路。

三种可能：
  fillable    —— 有 AcroForm 字段，按名字填，版式不会动
  flat        —— 没有字段，页面上只是画了线，只能按坐标叠加文字
  none        —— 连线也没有，大概不是表单

用法：
    python3 check_pdf_form.py input.pdf
"""

from __future__ import annotations

import argparse
import sys

try:
    from pypdf import PdfReader
except ImportError:
    print("需要 pypdf：pip install pypdf", file=sys.stderr)
    sys.exit(2)


def field_types(reader: "PdfReader") -> dict[str, int]:
    """统计字段类型。用 get_fields() 而不是遍历对象树，后者在坏文件上会抛。"""
    counts: dict[str, int] = {}
    try:
        fields = reader.get_fields() or {}
    except Exception as error:  # noqa: BLE001 - 坏文件就是坏文件，报出来即可
        print(f"读取字段时出错：{error}", file=sys.stderr)
        return counts
    for info in fields.values():
        # /FT 是字段类型：/Tx 文本、/Btn 按钮或复选框、/Ch 下拉、/Sig 签名
        kind = str(info.get("/FT", "unknown")).lstrip("/")
        counts[kind] = counts.get(kind, 0) + 1
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description="判断 PDF 表单的类型")
    parser.add_argument("pdf", help="要检查的 PDF")
    args = parser.parse_args()

    try:
        reader = PdfReader(args.pdf)
    except Exception as error:  # noqa: BLE001
        print(f"打不开这个文件：{error}", file=sys.stderr)
        sys.exit(1)

    if reader.is_encrypted:
        print("这个文件是加密的。先解密再检查：")
        print("  qpdf --password=口令 --decrypt input.pdf decrypted.pdf")
        sys.exit(1)

    counts = field_types(reader)
    total = sum(counts.values())

    if total > 0:
        print(f"fillable —— 找到 {total} 个可填字段：")
        for kind, count in sorted(counts.items()):
            print(f"  {kind}: {count}")
        print("\n下一步：")
        print("  python3 list_pdf_fields.py input.pdf        # 看字段名和可选值")
        print("  python3 fill_pdf_form.py in.pdf values.json out.pdf")
        return

    print("flat —— 没有可填字段。")
    print("页面上如果确实有空白待填处，那只是画出来的线，只能按坐标叠加文字：")
    print("  python3 add_pdf_text.py in.pdf out.pdf \"72,700,张三\" \"72,660,2026-01-01\"")
    print("\n坐标原点在左下角，单位是点（1 点 = 1/72 英寸）。")
    print("先把页面渲染成图片量像素再换算：点 = 像素 * 72 / dpi。")


if __name__ == "__main__":
    main()
