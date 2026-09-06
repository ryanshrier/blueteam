"""Extract genuine PDF text/coordinates for the handoff acceptance reader.

Explicit optional alternative to Poppler pdftotext. pdfplumber opens the PDF;
PDFMiner's layout analysis supplies text lines and character coordinates. No
browser DOM, expected passages, OCR, coordinate clamping, or synthetic text is
used. The XHTML-shaped output matches the existing bbox acceptance schema.
"""

import argparse
import html
import json
from pathlib import Path

import pdfplumber
import pdfminer
from pdfminer.layout import LTChar, LTTextLine


def text_lines(node):
    if isinstance(node, LTTextLine):
        yield node
    else:
        for child in getattr(node, "_objs", []):
            yield from text_lines(child)


def line_words(line, page_height):
    words = []
    characters = []

    def finish():
        if not characters:
            return
        words.append({
            "text": "".join(character.get_text() for character in characters),
            "xMin": min(character.x0 for character in characters),
            "yMin": page_height - max(character.y1 for character in characters),
            "xMax": max(character.x1 for character in characters),
            "yMax": page_height - min(character.y0 for character in characters),
        })
        characters.clear()

    for item in line:
        if isinstance(item, LTChar) and not item.get_text().isspace():
            characters.append(item)
        elif item.get_text().isspace():
            finish()
    finish()
    return words


def extract(pdf_path, output_directory):
    output_directory.mkdir(parents=True, exist_ok=True)
    plain_pages = []
    layout_pages = []
    bounds = ['<?xml version="1.0" encoding="UTF-8"?>', "<html><body><doc>"]
    word_count = 0
    line_count = 0
    with pdfplumber.open(pdf_path, laparams={
        "char_margin": 2.0, "word_margin": 0.1, "line_margin": 0.5,
        "boxes_flow": 0.5,
    }) as pdf:
        for page in pdf.pages:
            plain_lines = []
            bounds.append(f'<page width="{page.width:.6f}" height="{page.height:.6f}">')
            for line in text_lines(page.layout):
                words = line_words(line, page.height)
                if not words:
                    continue
                line_count += 1
                word_count += len(words)
                plain_lines.append(" ".join(word["text"] for word in words))
                left = min(word["xMin"] for word in words)
                top = min(word["yMin"] for word in words)
                bounds.append(f'<line xMin="{left:.6f}" yMin="{top:.6f}">')
                for word in words:
                    coordinates = " ".join(f'{key}="{word[key]:.6f}"' for key in ("xMin", "yMin", "xMax", "yMax"))
                    bounds.append(f'<word {coordinates}>{html.escape(word["text"])}</word>')
                bounds.append("</line>")
            bounds.append("</page>")
            plain_pages.append("\n".join(plain_lines))
            layout_pages.append(page.extract_text(layout=True) or "")
        page_count = len(pdf.pages)
    bounds.append("</doc></body></html>")
    (output_directory / "print-edition.txt").write_text("\f".join(plain_pages) + "\f", encoding="utf-8")
    (output_directory / "print-edition-layout.txt").write_text("\f".join(layout_pages) + "\f", encoding="utf-8")
    (output_directory / "print-edition-bounds.html").write_text("\n".join(bounds), encoding="utf-8")
    return {"engine": "pdfplumber/PDFMiner", "version": pdfplumber.__version__, "layoutVersion": pdfminer.__version__, "pages": page_count, "lines": line_count, "words": word_count}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output_directory", type=Path)
    arguments = parser.parse_args()
    print(json.dumps(extract(arguments.pdf, arguments.output_directory)))
