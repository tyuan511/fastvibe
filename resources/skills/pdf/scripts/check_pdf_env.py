#!/usr/bin/env python3
"""报告这台机器上有哪些 PDF 处理能力。

不安装任何东西，只做探测：Python 库能不能 import、命令行工具在不在 PATH 上。
输出一段给人看也方便机器读的报告，末尾给一句建议。

用法：
    python3 check_pdf_env.py [--json]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import sys

# (import 名, 展示名, 用途, 对应的 pip 包)
PYTHON_LIBS = [
    ("pypdf", "pypdf", "合并/拆分/旋转/加密/加水印", "pypdf"),
    ("pdfplumber", "pdfplumber", "提取文字与表格（带版式）", "pdfplumber"),
    ("reportlab", "reportlab", "生成 PDF", "reportlab"),
    ("pypdfium2", "pypdfium2", "页面渲染成图片（纯 Python）", "pypdfium2"),
    ("fitz", "PyMuPDF", "渲染与文本抽取（AGPL，速度快）", "PyMuPDF"),
    ("pdf2image", "pdf2image", "PDF 转图片（依赖 poppler）", "pdf2image"),
    ("pytesseract", "pytesseract", "OCR（还需系统装 tesseract）", "pytesseract"),
    ("pandas", "pandas", "表格导出 Excel/CSV", "pandas"),
    ("openpyxl", "openpyxl", "写 .xlsx（pandas 需要）", "openpyxl"),
]

# (命令, 所属包, 用途, 各平台安装提示)
CLI_TOOLS = [
    ("pdftotext", "poppler", "命令行提取文字", "brew install poppler / apt install poppler-utils"),
    ("pdftoppm", "poppler", "命令行页面转图片", "brew install poppler / apt install poppler-utils"),
    ("pdfimages", "poppler", "提取内嵌图片", "brew install poppler / apt install poppler-utils"),
    ("qpdf", "qpdf", "页面级手术、解密", "brew install qpdf / apt install qpdf"),
    ("tesseract", "tesseract", "OCR 引擎本体", "brew install tesseract tesseract-lang / apt install tesseract-ocr"),
    ("pdftk", "pdftk", "合并拆分（可选，常缺）", "brew install pdftk-java / apt install pdftk"),
]


def has_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        # 一个装坏了的包会在这里抛异常，那也算「不能用」。
        return False


def collect() -> dict:
    libs = [
        {"module": mod, "name": label, "use": use, "pip": pip, "available": has_module(mod)}
        for mod, label, use, pip in PYTHON_LIBS
    ]
    tools = [
        {
            "command": cmd,
            "package": pkg,
            "use": use,
            "install": hint,
            "available": shutil.which(cmd) is not None,
        }
        for cmd, pkg, use, hint in CLI_TOOLS
    ]
    return {"python": sys.version.split()[0], "libraries": libs, "tools": tools}


def summarize(report: dict) -> list[str]:
    """给出下一步该做什么，而不是只丢一张表。"""
    have_libs = {item["module"] for item in report["libraries"] if item["available"]}
    have_tools = {item["command"] for item in report["tools"] if item["available"]}
    lines: list[str] = []

    if not have_libs and not have_tools:
        lines.append("这台机器上没有任何 PDF 库或命令行工具。")
        lines.append("最小可用组合：pip install pypdf pdfplumber（提取与页面操作都能做）。")
        lines.append("要 OCR 或提取内嵌图片，还需要 poppler：brew install poppler（macOS）。")
        return lines

    if "pypdf" not in have_libs:
        lines.append("缺 pypdf：合并/拆分/旋转/加密/加水印做不了 → pip install pypdf")
    if "pdfplumber" not in have_libs:
        lines.append("缺 pdfplumber：带版式的文字与表格提取会退化 → pip install pdfplumber")
    if not have_libs & {"pypdfium2", "fitz"} and not have_tools & {"pdftoppm"}:
        lines.append("没有任何渲染途径：页面转图片做不了 → pip install pypdfium2 或装 poppler")
    if not have_libs & {"pytesseract"} or "tesseract" not in have_tools:
        lines.append("扫描件 OCR 不可用（需要 pytesseract + tesseract 本体），遇到纯图片 PDF 要如实告知用户")
    if "reportlab" not in have_libs:
        lines.append("缺 reportlab：生成新 PDF 做不了 → pip install reportlab")

    if not lines:
        lines.append("环境齐全，按 SKILL.md 的分工表直接开工。")
    return lines


def main() -> None:
    parser = argparse.ArgumentParser(description="探测本机的 PDF 处理能力")
    parser.add_argument("--json", action="store_true", help="输出 JSON，便于程序读取")
    args = parser.parse_args()

    report = collect()
    if args.json:
        report["summary"] = summarize(report)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    print(f"Python {report['python']}\n")
    print("Python 库:")
    for item in report["libraries"]:
        mark = "✓" if item["available"] else "✗"
        print(f"  {mark} {item['name']:<12} {item['use']}")

    print("\n命令行工具:")
    for item in report["tools"]:
        mark = "✓" if item["available"] else "✗"
        print(f"  {mark} {item['command']:<12} {item['use']}")

    print("\n建议:")
    for line in summarize(report):
        print(f"  - {line}")


if __name__ == "__main__":
    main()
