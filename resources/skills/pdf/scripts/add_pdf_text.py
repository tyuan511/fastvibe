#!/usr/bin/env python3
"""在 PDF 页面的指定坐标上叠加文字——用于没有可填字段的扁平表单。

这类 PDF 的「待填处」只是画出来的线，PDF 层面没有字段对象，所以只能自己算位置。

用法：
    python3 add_pdf_text.py input.pdf output.pdf "72,700,张三" "72,660,2026-01-01"

每个参数是 `x,y,文本`：
    x, y   坐标，单位是点（1 点 = 1/72 英寸），原点在**左下角**，y 越大越靠上
    文本   要写的字

可选项：
    --page N       只写第 N 页（默认第 1 页）
    --size N       字号，默认 11
    --font PATH    用系统里的 TTF（写中文时建议给，否则用内置的 CID 字体）
    --dry-run      只打印算出来的位置，不写文件

坐标怎么定：把页面渲染成图片，在图上量出像素位置，再换算
    点 = 像素 * 72 / dpi
例如 200 DPI 的图上量到 (400, 300)，就是 400*72/200 = 144 点、300*72/200 = 108 点。
注意图片的 y 从顶部算起，而 PDF 的 y 从底部算起，所以要转：pdf_y = 页面高度 - 图片y换算值。
"""

from __future__ import annotations

import argparse
import sys

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:
    print("需要 pypdf：pip install pypdf", file=sys.stderr)
    sys.exit(2)

try:
    from reportlab.lib.colors import black
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
except ImportError:
    print("需要 reportlab：pip install reportlab", file=sys.stderr)
    sys.exit(2)

# ReportLab 自带的中文 CID 字体，不需要任何字体文件。写中文时的默认选择。
CID_FONT = "STSong-Light"


def parse_entries(raw: list[str]) -> list[tuple[float, float, str]]:
    entries: list[tuple[float, float, str]] = []
    for item in raw:
        parts = item.split(",", 2)
        if len(parts) != 3:
            print(f"格式不对（应为 x,y,文本）：{item}", file=sys.stderr)
            sys.exit(1)
        try:
            x, y = float(parts[0]), float(parts[1])
        except ValueError:
            print(f"坐标不是数字：{item}", file=sys.stderr)
            sys.exit(1)
        entries.append((x, y, parts[2]))
    return entries


def main() -> None:
    parser = argparse.ArgumentParser(description="在 PDF 上按坐标叠加文字")
    parser.add_argument("pdf", help="输入 PDF")
    parser.add_argument("output", help="输出 PDF")
    parser.add_argument("entries", nargs="+", help="每项形如 \"x,y,文本\"")
    parser.add_argument("--page", type=int, default=1, help="第几页（从 1 开始，默认 1）")
    parser.add_argument("--size", type=float, default=11, help="字号（默认 11）")
    parser.add_argument("--font", help="系统 TTF 字体路径")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不写文件")
    args = parser.parse_args()

    entries = parse_entries(args.entries)

    try:
        reader = PdfReader(args.pdf)
    except Exception as error:  # noqa: BLE001
        print(f"打不开这个文件：{error}", file=sys.stderr)
        sys.exit(1)

    if args.page < 1 or args.page > len(reader.pages):
        print(f"页码超出范围：这个文件有 {len(reader.pages)} 页", file=sys.stderr)
        sys.exit(1)

    page = reader.pages[args.page - 1]
    # mediabox 可能是非零原点（裁切过的页面），落位必须减掉它，否则整体偏移。
    box = page.mediabox
    offset_x, offset_y = float(box.left), float(box.bottom)
    width, height = float(box.width), float(box.height)

    if args.dry_run:
        print(f"页面 {args.page}：{width:.0f} x {height:.0f} 点（原点 {offset_x:.0f},{offset_y:.0f}）")
        for x, y, text in entries:
            inside = 0 <= x <= width and 0 <= y <= height
            print(f"  ({x:.0f}, {y:.0f}) {'✓' if inside else '✗ 超出页面'}  {text}")
        return

    font_name = CID_FONT
    if args.font:
        try:
            font_name = "CustomFont"
            pdfmetrics.registerFont(TTFont(font_name, args.font))
        except Exception as error:  # noqa: BLE001
            print(f"注册字体失败，改用内置中文字体：{error}", file=sys.stderr)
            font_name = CID_FONT
    if font_name == CID_FONT:
        # 重复注册同一个 CID 字体是安全的，但只在需要时注册。
        try:
            pdfmetrics.registerFont(UnicodeCIDFont(CID_FONT))
        except Exception:  # noqa: BLE001 - 已注册过
            pass

    # 把文字画在一张和页面同样大小的透明 PDF 上，再盖到原页面。
    # 直接用 pypdf 往内容流里塞文字很脆（字体资源要自己挂），这样最稳。
    from io import BytesIO

    buffer = BytesIO()
    overlay = canvas.Canvas(buffer, pagesize=(width, height))
    overlay.setFillColor(black)
    overlay.setFont(font_name, args.size)
    for x, y, text in entries:
        # 页面有非零原点时，用户给的坐标是相对页面左下角的，所以加回原点。
        overlay.drawString(offset_x + x, offset_y + y, text)
    overlay.save()
    buffer.seek(0)

    stamp = PdfReader(buffer).pages[0]
    page.merge_page(stamp)

    writer = PdfWriter()
    writer.append(reader)
    with open(args.output, "wb") as handle:
        writer.write(handle)

    print(f"已写入 {args.output}（第 {args.page} 页，{len(entries)} 处文字）")
    print("请渲染出来确认没有压到边框或别的字上。")


if __name__ == "__main__":
    main()
