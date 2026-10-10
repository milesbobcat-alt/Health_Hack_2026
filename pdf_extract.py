"""Extract selectable PDF text from stdin. The uploaded bytes are never saved."""

import io
import json
import sys

from pypdf import PdfReader


def main():
    try:
        reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()), strict=False)
        if reader.is_encrypted:
            print(json.dumps({"error": "This PDF is password protected. Unlock it before uploading."}))
            return
        if len(reader.pages) > 40:
            print(json.dumps({"error": "Choose a PDF with 40 pages or fewer."}))
            return
        pages = []
        for page in reader.pages:
            pages.append(page.extract_text(extraction_mode="layout") or "")
        text = "\n\n".join(page.strip() for page in pages if page.strip()).strip()
        if not text:
            print(json.dumps({"error": "No selectable text found. This may be a scanned PDF; paste the instructions instead."}))
            return
        if len(text) > 200_000:
            print(json.dumps({"error": "The extracted text is too long. Select a shorter PDF."}))
            return
        print(json.dumps({"text": text, "pages": len(reader.pages)}))
    except Exception:
        print(json.dumps({"error": "This PDF could not be read. Try another file."}))


if __name__ == "__main__":
    main()
