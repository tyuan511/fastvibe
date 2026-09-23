---
name: pdf
description: 处理 PDF 文件——读取与提取文字/表格、合并、拆分、旋转、加水印、加密解密、提取图片、扫描件 OCR、填写表单，以及生成新的 PDF。当用户附带了 .pdf 文件、提到某个 PDF 路径、要求输出 PDF，或说「看看这份文件/合同/报告/发票/论文」而附件是 PDF 时使用。附件里有 PDF 时应当优先走这个技能，而不是凭文件名猜内容。
---

# PDF 处理

PDF 的工作几乎都落在两类东西上：**Python 库**（pypdf / pdfplumber / reportlab）和**命令行工具**（poppler 的 `pdftotext` / `pdfimages`，以及 `qpdf`）。它们各有所长——见下面的分工表——所以第一步永远是先确认这台机器上有什么。

## 第 0 步：先探测环境，再决定怎么做

**不要假设库或工具已经装好。** 直接 `import pypdf` 会失败，而失败的报错会把你引向「装一个库」，但很多任务用系统自带的东西就能做。

先跑一次探测脚本，它把可用的库和命令列出来：

```bash
python3 <技能目录>/scripts/check_pdf_env.py
```

（`<技能目录>` 是这个 SKILL.md 所在目录的绝对路径。）

拿到结果后按这个顺序决策：

1. **有库/工具就用**，按下面的分工表挑最合适的。
2. **缺什么就装什么**，但先说一句要装什么、为什么。Python 库用 `pip install`，命令行工具用系统的包管理器（macOS `brew install poppler qpdf`，Debian/Ubuntu `apt install poppler-utils qpdf`）。装之前告诉用户，因为这是在改他的机器。
3. **什么都不能装时**（没有网络、没有权限），还有退路：PDF 的文件结构是公开的，纯文本抽取用正则读未压缩流也能应付简单文件；但扫描件（纯图片）没有 OCR 就没有任何办法。这种情况要如实告诉用户做不到，不要编内容。

**macOS 上有一个不用装东西的兜底**：系统自带 `sips` 和 Quartz（`python3` 里的 `Quartz` 模块通常没有，但 `/usr/bin/qlmanage` 能生成预览图）。真要 OCR，macOS 的 Vision 框架通过 `shortcuts` 或 `osascript` 可用，但依赖较多，只在用户明确需要且没有别的办法时考虑。

## 分工表：什么任务用什么

| 任务 | 首选 | 说明 |
| --- | --- | --- |
| 提取文字 | `pdfplumber` | 带版式，比 pypdf 的 `extract_text` 准 |
| 提取表格 | `pdfplumber.extract_tables()` | 它懂表格线；复杂表转 DataFrame |
| 合并 / 拆分 / 旋转 / 加密 | `pypdf` | 纯 Python，不依赖外部程序 |
| 加水印 | `pypdf` | 把水印页 `merge_page` 到每页 |
| 提取内嵌图片 | `pdfimages -j` | poppler 的，比 Python 逐对象挖省事 |
| 页面转图片 | `pdftoppm`（poppler）或 `pypdfium2` | 渲染质量好、速度快 |
| 生成 PDF | `reportlab` | Canvas 画坐标，Platypus 排文档 |
| 页面级手术（删除/重排/合并页） | `qpdf` | 命令行，不重写整个文件，快且稳 |
| 扫描件 OCR | `pytesseract` + `pdf2image` | 必须先渲染成图 |
| 填写表单 | 见「表单」一节 | 可填字段和不可填字段是两条路 |

## 提取文字与表格

```python
import pdfplumber

with pdfplumber.open("doc.pdf") as pdf:
    print(f"页数: {len(pdf.pages)}")
    for i, page in enumerate(pdf.pages, 1):
        print(f"--- 第 {i} 页 ---")
        print(page.extract_text() or "(这一页没有可抽取的文字)")
```

`extract_text()` 返回 `None` 而不是空串，表示这一页抽不出文字——**这通常意味着它是扫描件**，此时不要继续按文本处理，去看 OCR 那一节。

表格：

```python
with pdfplumber.open("doc.pdf") as pdf:
    for i, page in enumerate(pdf.pages, 1):
        for j, table in enumerate(page.extract_tables(), 1):
            print(f"第 {i} 页第 {j} 张表:")
            for row in table:
                print(row)
```

表格的第一个非空行往往是表头，但**不要无条件当成表头**——有些 PDF 的表没有表头行，有些有跨页续表。看一眼再决定。要导出 Excel 就转 `pandas.DataFrame` 后 `to_excel`（需要 `openpyxl`）。

## 合并、拆分、旋转

```python
from pypdf import PdfReader, PdfWriter

# 合并：按给定顺序
writer = PdfWriter()
for path in ["a.pdf", "b.pdf", "c.pdf"]:
    for page in PdfReader(path).pages:
        writer.add_page(page)
with open("merged.pdf", "wb") as f:
    writer.write(f)
```

```python
# 拆分：每页一个文件
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages, 1):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i}.pdf", "wb") as f:
        writer.write(f)
```

```python
# 旋转（rotate 是顺时针角度，90 的倍数最安全）
reader = PdfReader("input.pdf")
writer = PdfWriter()
page = reader.pages[0]
page.rotate(90)
writer.add_page(page)
with open("rotated.pdf", "wb") as f:
    writer.write(f)
```

要按页范围抽取或重排，`qpdf` 比写循环干净：

```bash
qpdf input.pdf --pages . 1-5 -- part1.pdf      # 第 1-5 页
qpdf input.pdf --pages . 6-10 -- part2.pdf     # 第 6-10 页
qpdf --empty --pages a.pdf b.pdf -- merged.pdf # 合并
qpdf input.pdf out.pdf --rotate=+90:1          # 第 1 页转 90 度
```

## 加水印

```python
from pypdf import PdfReader, PdfWriter

watermark = PdfReader("watermark.pdf").pages[0]
reader = PdfReader("document.pdf")
writer = PdfWriter()
for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)
with open("watermarked.pdf", "wb") as f:
    writer.write(f)
```

`merge_page` 把水印**叠加**在页面上；`page.merge_transformed_page` 可以缩放和定位。如果水印要半透明，透明度得在水印 PDF 本身里设好（PDF 的 `ExtGState`），pypdf 不替你算。

## 加密与解密

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
writer.encrypt(user_password="用户口令", owner_password="所有者口令")
with open("encrypted.pdf", "wb") as f:
    writer.write(f)
```

读加密文件：

```python
reader = PdfReader("encrypted.pdf")
if reader.is_encrypted:
    reader.decrypt("用户口令")
```

`qpdf` 更省事：`qpdf --password=口令 --decrypt in.pdf out.pdf`。

**权限和加密是两回事。** PDF 有「所有者口令」控制打印/复制/改动的权限位，很多阅读器不强制。如果用户要的是「不许复制」，光设口令不够——得说清这一点。

## 提取内嵌图片

```bash
pdfimages -j input.pdf out          # 得到 out-000.jpg, out-001.jpg, ...
pdfimages -list input.pdf           # 先看有哪些图、什么格式
```

`-j` 让 JPEG 直接落盘而不重新编码，保真且快。没有 poppler 时用 `pypdf` 遍历页面对象里的 `/XObject`，但要自己处理滤镜和颜色空间，通常不值得。

## 页面转图片与 OCR

渲染：

```bash
pdftoppm -png -r 200 input.pdf page    # 200 DPI，得到 page-1.png, ...
```

或纯 Python：

```python
import pypdfium2 as pdfium
pdf = pdfium.PdfDocument("input.pdf")
for i, page in enumerate(pdf, 1):
    page.render(scale=200 / 72).to_pil().save(f"page-{i}.png")
```

OCR（只有确认是扫描件时才做）：

```python
import pytesseract
from pdf2image import convert_from_path

for i, image in enumerate(convert_from_path("scanned.pdf", dpi=200), 1):
    print(f"--- 第 {i} 页 ---")
    print(pytesseract.image_to_string(image, lang="chi_sim+eng"))
```

`lang` 要按内容选：`chi_sim` 简体、`chi_tra` 繁体、`eng` 英文。**装错语言包会输出乱码而不是报错**，所以结果看着不对时先查这个。中文 OCR 的质量明显低于英文，重要内容要人工核对。

## 生成 PDF

```python
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

c = canvas.Canvas("hello.pdf", pagesize=A4)
width, height = A4
c.drawString(72, height - 72, "Hello World!")
c.save()
```

多页文档用 Platypus（它负责分页和排版）：

```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak

doc = SimpleDocTemplate("report.pdf", pagesize=A4)
styles = getSampleStyleSheet()
doc.build([
    Paragraph("报告标题", styles["Title"]),
    Spacer(1, 12),
    Paragraph("正文段落。" * 20, styles["Normal"]),
    PageBreak(),
    Paragraph("第二页", styles["Heading1"]),
])
```

**不要用 Unicode 上下标字符（₀₁₂、⁰¹²）**：ReportLab 内置字体没有这些字形，会渲染成实心黑块。用标记代替——`Paragraph("H<sub>2</sub>O")` 和 `Paragraph("x<super>2</super>")`。Canvas 上画字时则要手动调字号和位置。

**中文字体必须显式注册**，否则中文全是方块：

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))  # 内置的中文 CID 字体
```

或注册系统里的 TTF：`pdfmetrics.registerFont(TTFont("SourceHan", "/path/to/SourceHanSans.ttf"))`，然后在 style 里设 `fontName`。

## 表单

填写 PDF 表单有两条完全不同的路，**先判断是哪一种**，走错了会得到一张空白或错位的表单：

```bash
python3 <技能目录>/scripts/check_pdf_form.py input.pdf
```

- **有可填字段（AcroForm）**：PDF 里有命名的字段对象，直接按名字写值即可，版式不会动。
  ```bash
  python3 <技能目录>/scripts/list_pdf_fields.py input.pdf          # 看有哪些字段、什么类型
  python3 <技能目录>/scripts/fill_pdf_form.py input.pdf values.json out.pdf
  ```
  `values.json` 形如 `{"name": "张三", "agree": true, "date": "2026-01-01"}`。复选框用布尔，单选组用选项名。
- **没有可填字段（扁平表单）**：页面上只是画了线和字，PDF 层面没有字段。这时只能在**指定坐标**上叠加文字或图形：
  ```bash
  python3 <技能目录>/scripts/add_pdf_text.py input.pdf out.pdf "72,700,张三" "72,660,2026-01-01"
  ```
  坐标是 `x,y,文本`，单位是 PDF 点（1 点 = 1/72 英寸），**原点在左下角**，y 越大越靠上。要精确落位，先把页面渲染成图片量像素，再换算：`点 = 像素 * 72 / dpi`。

不可填表单的落位一定要**先渲染出来看一眼**再交，肉眼确认文字没压到边框或别的字上。填完把结果渲染成图片给用户看，比只报一个文件名有用得多。

## 交付前自检

- **页数对不对**：改过页面的操作（合并、拆分、删页）都要 `len(PdfReader(out).pages)` 核一遍。
- **中文没变方块**：生成 PDF 后渲染一页看看，别只检查文件存在。
- **文本抽取为空**：先怀疑扫描件，别怀疑代码。
- **加密文件读不出**：`reader.is_encrypted` 为真时先 `decrypt`，否则 `pages` 会抛错。

## 参考

- `reference.md` —— pypdfium2、pdf-lib（JS）、更多疑难排查。
- `forms.md` —— 表单填写的完整流程与坐标换算细节。
