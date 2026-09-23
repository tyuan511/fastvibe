# PDF 进阶参考

主文件 `SKILL.md` 覆盖了日常操作。这里放不常用但关键时刻能救场的部分：渲染、JavaScript 库、疑难排查。

## 目录

- [渲染引擎的选择](#渲染引擎的选择)
- [pypdfium2 用法](#pypdfium2-用法)
- [JavaScript 库（Node 环境）](#javascript-库node-环境)
- [疑难排查](#疑难排查)
- [性能](#性能)

## 渲染引擎的选择

「把 PDF 变成图片」有好几条路，选错了会白费很多时间：

| 方案 | 依赖 | 速度 | 适用 |
| --- | --- | --- | --- |
| `pdftoppm` | poppler（系统） | 快 | 命令行批处理，最省事 |
| `pypdfium2` | 纯 pip，自带二进制 | 快 | 不想装系统包时的首选 |
| PyMuPDF (`fitz`) | pip | 最快 | 大量处理；但许可证是 **AGPL**，商用项目要留意 |
| `pdf2image` | poppler + pip | 中 | 只是 `pdftoppm` 的 Python 包装 |

**不要用 `pdf2image` 却不装 poppler**——它的报错是「Unable to get page count」，不会告诉你缺 poppler。

## pypdfium2 用法

不需要系统依赖，适合在用户机器上「装一个 pip 包就能跑」。

```python
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument("input.pdf")
print(f"页数: {len(pdf)}")

# 渲染：scale 是相对 72 DPI 的倍率
# 200 DPI 的 scale = 200 / 72 ≈ 2.78
for i, page in enumerate(pdf, 1):
    bitmap = page.render(scale=200 / 72)
    bitmap.to_pil().save(f"page-{i}.png")

pdf.close()
```

抽取文字（1.x 的接口，和渲染是两套）：

```python
import pypdfium2 as pdfium
pdf = pdfium.PdfDocument("input.pdf")
for i, page in enumerate(pdf, 1):
    textpage = page.get_textpage()
    print(f"--- 第 {i} 页 ---")
    print(textpage.get_text_range())
```

版本差异提醒：pypdfium2 在 4.x 之后把 `PdfPage.get_textpage()` 移到了 `PdfDocument` 上（`pdf[i].get_textpage()` 仍然可用，但旧教程里的写法可能报 AttributeError）。**先 `pip show pypdfium2` 看版本**，再照对应文档写。

## JavaScript 库（Node 环境）

有些任务在 Node 里更顺（比如要和前端的 PDF 预览配合）。

### pdf-lib —— 生成与修改

```javascript
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const doc = await PDFDocument.create();
const page = doc.addPage([595, 842]);            // A4，单位是点
const font = await doc.embedFont(StandardFonts.Helvetica);

page.drawText("Hello World", { x: 72, y: 770, size: 14, font, color: rgb(0, 0, 0) });
const bytes = await doc.save();
```

**pdf-lib 的内置字体（StandardFonts）不支持中文**，写中文要 `embedFont` 一个 TTF 字节流：

```javascript
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFileSync } from "node:fs";

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const font = await doc.embedFont(readFileSync("/path/to/SourceHanSans.ttf"));
```

不注册 fontkit 就直接 embedFont 会抛「fontkit not registered」。

### 其他

- **pdfjs-dist** —— 渲染和抽取，Mozilla 的，浏览器里的事实标准。
- **pdfkit** —— 服务端生成，流式写入，适合大文档。

## 疑难排查

### 提取出来的文字是乱码

最常见的原因按概率排：

1. **字体没有正确的 ToUnicode 映射**。这是 PDF 生成工具的缺陷，文件本身「合法」。pypdf 和 pdfplumber 都救不了；只能 OCR（把页面渲染成图再识别），精度会下降。
2. **用了自定义编码的子集字体**。同上。
3. **OCR 语言包不对**。中文内容用了 `eng`，输出会是乱码而非报错。

判断方法：`pdffonts input.pdf`（poppler）会列出每个字体的编码方式。带 `Identity-H` 且没有 ToUnicode 的，基本就是第 1 种。

### 文件打不开 / 结构损坏

先试着让 `qpdf` 修一遍，它比大多数工具更能容忍坏结构：

```bash
qpdf --check input.pdf              # 报告问题
qpdf --replace-input input.pdf      # 原地重写，修掉小毛病
```

`--check` 的退出码：0 没问题，2 有错但能恢复，3 有错。**先 `--check` 再动手**，别在坏文件上直接做手术。

### 页面尺寸不对 / 内容被裁掉

PDF 有 `MediaBox`（物理页面）和 `CropBox`（显示区域）两套。很多工具只看 MediaBox，所以裁切过的页面会算错坐标：

```python
page = reader.pages[0]
print("MediaBox:", page.mediabox)   # 物理大小
print("CropBox: ", page.cropbox)    # 实际显示
```

叠加文字、加水印时要用 **CropBox**，并且减去它的左下角原点——`add_pdf_text.py` 已经处理了这一点。

### 合并后书签和链接丢了

pypdf 的 `add_page` 不会搬运大纲和注释。要保留就得手动处理：

```python
writer.add_outline_item("第一章", 0)   # 至少把大纲重建出来
```

跨文件的内部链接几乎不可能自动修好（目标页码变了），老实告诉用户这一点。

### 文件很大

- 图片是主因。`pdfimages -list` 看每张图的 DPI 和压缩方式，超采样过的图先降采样。
- 用 `qpdf --optimize-level=3 --linearize in.pdf out.pdf` 做无损优化。
- 扫描件建议走 OCR 后**重建** PDF（文字层 + 压缩过的图），比原文件小一个数量级。

## 性能

- **不要在循环里反复开文件**。`PdfReader` 一次读进来，逐页处理。
- **渲染是最贵的一步**。只渲染需要的页（`pdftoppm -f 3 -l 5`），别整本渲染再挑。
- **大文件用流式写入**：`PdfWriter` 边加页边写，别把所有页都留在内存里。
- 几百页以上、又只需要文字时，`pdftotext` 比任何 Python 方案都快得多。
