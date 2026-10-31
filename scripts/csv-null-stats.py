#!/usr/bin/env python3
"""统计 CSV 每列的空值数量。

用法:
    python3 scripts/csv-null-stats.py data.csv
    python3 scripts/csv-null-stats.py data.csv --delimiter ';' --encoding gbk
    cat data.csv | python3 scripts/csv-null-stats.py -

空值 = 空字符串，或（默认）去掉首尾空白后为空。用 --strict 只把真正的空字符串算作空值。
只用标准库，不依赖 pandas。
"""

from __future__ import annotations

import argparse
import csv
import sys
import unicodedata
from typing import TextIO


def open_input(path: str, encoding: str) -> TextIO:
    if path == "-":
        # 从管道读时沿用 stdin 的编码，避免二次解码
        return sys.stdin
    return open(path, "r", encoding=encoding, newline="")


def count_nulls(
    handle: TextIO, delimiter: str, quotechar: str, strict: bool
) -> tuple[list[str], list[int], int, int]:
    reader = csv.reader(handle, delimiter=delimiter, quotechar=quotechar)

    try:
        header = next(reader)
    except StopIteration:
        raise SystemExit("错误：文件是空的，没有表头。")

    counts = [0] * len(header)
    rows = 0
    ragged = 0

    for row in reader:
        # 跳过完全空白的行（常见于文件末尾）
        if not row:
            continue
        rows += 1
        if len(row) != len(header):
            ragged += 1

        for i in range(len(header)):
            value = row[i] if i < len(row) else ""
            if (value == "" if strict else value.strip() == ""):
                counts[i] += 1

    return header, counts, rows, ragged


def display_width(text: str) -> int:
    """终端里的显示宽度：CJK 等全角字符占两列。"""
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def pad(text: str, width: int, align: str = "left") -> str:
    filler = " " * (width - display_width(text))
    return filler + text if align == "right" else text + filler


def format_table(header: list[str], counts: list[int], rows: int) -> str:
    name_w = max([display_width("列名"), *(display_width(h) for h in header)])
    count_w = max(len("空值"), len(str(rows)))
    pct_w = 6

    lines = [
        f"{pad('列名', name_w)}  {pad('空值', count_w, 'right')}  {pad('占比', pct_w, 'right')}",
        f"{'-' * name_w}  {'-' * count_w}  {'-' * pct_w}",
    ]
    for name, count in zip(header, counts):
        pct = f"{count / rows * 100:.1f}%" if rows else "-"
        lines.append(
            f"{pad(name, name_w)}  {pad(str(count), count_w, 'right')}  {pad(pct, pct_w, 'right')}"
        )

    lines.append("")
    lines.append(f"共 {rows} 行数据，{len(header)} 列。")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="统计 CSV 每列的空值数量")
    parser.add_argument("path", help="CSV 文件路径，用 - 表示从标准输入读取")
    parser.add_argument("-d", "--delimiter", default=",", help="分隔符，默认 ,")
    parser.add_argument("-q", "--quotechar", default='"', help='引号字符，默认 "')
    parser.add_argument(
        "-e", "--encoding", default="utf-8-sig", help="文件编码，默认 utf-8-sig（兼容 BOM）"
    )
    parser.add_argument(
        "--strict", action="store_true", help="只把空字符串算作空值，纯空白不算"
    )
    args = parser.parse_args(argv)

    try:
        handle = open_input(args.path, args.encoding)
    except OSError as exc:
        print(f"错误：无法读取 {args.path}：{exc.strerror}", file=sys.stderr)
        return 1

    try:
        header, counts, rows, ragged = count_nulls(
            handle, args.delimiter, args.quotechar, args.strict
        )
    except UnicodeDecodeError as exc:
        print(
            f"错误：按 {args.encoding} 解码失败（{exc.reason}，位置 {exc.start}）。"
            "试试 --encoding gbk 或 --encoding latin-1。",
            file=sys.stderr,
        )
        return 1
    except csv.Error as exc:
        print(f"错误：CSV 解析失败：{exc}", file=sys.stderr)
        return 1
    finally:
        if handle is not sys.stdin:
            handle.close()

    print(format_table(header, counts, rows))
    if ragged:
        print(f"注意：{ragged} 行的字段数与表头不一致，缺失的字段按空值统计。", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
