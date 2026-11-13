#!/usr/bin/env python3
"""Read-only OOXML checks and structural summaries; no rendering or formula evaluation.

Run with INPUT.docx, INPUT.pptx, or INPUT.xlsx. Optional --contains assertions
check extracted text; DOCX excludes comments, glossary text, and unreferenced parts or notes.
--count checks slides or sheets. JSON escapes non-ASCII
characters and goes to stdout and optionally --out. Exit 0 means the requested
structural checks passed, 1 means a document, assertion, or report write failed, and 2 means
invalid command-line arguments.
"""

from __future__ import annotations

import argparse
import json
import posixpath
import sys
import zipfile
import zlib
from array import array
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET

W_NAMESPACES = (
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
)
A_NAMESPACES = (
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "http://purl.oclc.org/ooxml/drawingml/main",
)
P_NAMESPACES = (
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "http://purl.oclc.org/ooxml/presentationml/main",
)
S_NAMESPACES = (
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
)
R_NAMESPACES = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
)
MAIN_PARTS = {
    ".docx": ("word/document.xml", "wordprocessingml.document.main+xml"),
    ".pptx": ("ppt/presentation.xml", "presentationml.presentation.main+xml"),
    ".xlsx": ("xl/workbook.xml", "spreadsheetml.sheet.main+xml"),
}


def namespace(root: ET.Element, supported: tuple[str, ...], part: str) -> str:
    """Return the main XML namespace after checking its OOXML variant."""
    uri = root.tag[1:].split("}", 1)[0] if root.tag.startswith("{") else ""
    if uri not in supported:
        raise ValueError(f"{part} uses unsupported XML namespace: {uri or '(none)'}")
    return "{" + uri + "}"


def relationship_id(node: ET.Element, part: str) -> str:
    """Read an office-document relationship id from Transitional or Strict OOXML."""
    for uri in R_NAMESPACES:
        value = node.get("{" + uri + "}id")
        if value is not None:
            return value
    raise ValueError(f"{part} has a reference without a relationship id")


def relationship_types(kind: str) -> set[str]:
    """Return the Transitional and Strict relationship type names for one role."""
    return {f"{uri}/{kind}" for uri in R_NAMESPACES}


def iter_namespaces(root: ET.Element, namespaces: tuple[str, ...], local_name: str):
    """Iterate matching elements across Transitional and Strict namespaces."""
    for uri in namespaces:
        yield from root.iter("{" + uri + "}" + local_name)


def relationship_target(part: str, target: str) -> str:
    """Resolve a package relationship without fetching external resources."""
    path = unquote(urlsplit(target).path)
    return posixpath.normpath(path.lstrip("/") if path.startswith("/") else posixpath.join(posixpath.dirname(part), path))


def relationships(part: str, xml: dict[str, ET.Element], types: set[str] | None = None) -> dict[str, str]:
    path = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    root = xml.get(path)
    if root is None:
        return {}
    return {
        rel.attrib["Id"]: relationship_target(part, rel.attrib["Target"])
        for rel in root if rel.get("TargetMode") != "External" and (types is None or rel.get("Type") in types)
    }


def related_xml(part: str, reference: str, links: dict[str, str], xml: dict[str, ET.Element]) -> ET.Element:
    """Read a related XML part with diagnostics naming its source and reference."""
    if reference not in links:
        raise ValueError(f"{part} references missing relationship: {reference}")
    target = links[reference]
    if target not in xml:
        raise ValueError(f"{part} relationship {reference} targets a non-XML member: {target}")
    return xml[target]


def inspect_docx(xml: dict[str, ET.Element]) -> tuple[dict, str]:
    part = "word/document.xml"
    root = xml[part]
    w = namespace(root, W_NAMESPACES, part)
    body = root.find(f"{w}body")
    if body is None:
        raise ValueError("word/document.xml has no document body")
    tables = []
    for table in body.iter(f"{w}tbl"):
        grid = table.findall(f"{w}tblGrid/{w}gridCol")
        rows = table.findall(f"{w}tr")
        # Merged cells span logical grid columns; counting physical cells loses them.
        columns = len(grid) if grid else max((sum(
            int(cell.find(f"{w}tcPr/{w}gridSpan").get(f"{w}val", "1"))
            if cell.find(f"{w}tcPr/{w}gridSpan") is not None else 1
            for cell in row.findall(f"{w}tc")
        ) for row in rows), default=0)
        tables.append({"rows": len(rows), "columns": columns})
    sections = []
    for section in body.iter(f"{w}sectPr"):
        size = section.find(f"{w}pgSz")
        margins = section.find(f"{w}pgMar")
        sections.append({
            "page_twips": {} if size is None else {key.removeprefix(w): value for key, value in size.attrib.items()},
            "margins_twips": {} if margins is None else {key.removeprefix(w): value for key, value in margins.attrib.items()},
        })
    text_parts = [body]
    for kind in ("header", "footer"):
        links = relationships(part, xml, relationship_types(kind))
        for section in body.iter(f"{w}sectPr"):
            for reference in section.findall(f"{w}{kind}Reference"):
                text_parts.append(related_xml(part, relationship_id(reference, part), links, xml))
    for kind in ("footnote", "endnote"):
        references = {node.attrib[f"{w}id"] for node in body.iter(f"{w}{kind}Reference")}
        if not references:
            continue
        links = relationships(part, xml, relationship_types(f"{kind}s"))
        for reference in links:
            tree = related_xml(part, reference, links, xml)
            text_parts.extend(note for note in tree.findall(f"{w}{kind}") if note.get(f"{w}id") in references)
    text = "\n".join("".join(node.text or "" for node in paragraph.iter(f"{w}t")) for tree in text_parts
                     for paragraph in tree.iter(f"{w}p"))
    return {"paragraphs": len(list(body.iter(f"{w}p"))), "tables": tables, "sections": sections}, text


def inspect_pptx(xml: dict[str, ET.Element]) -> tuple[dict, str]:
    part = "ppt/presentation.xml"
    links = relationships(part, xml)
    root = xml[part]
    p = namespace(root, P_NAMESPACES, part)
    slides = root.findall(f"{p}sldIdLst/{p}sldId")
    texts = []
    for slide in slides:
        reference = relationship_id(slide, part)
        tree = related_xml(part, reference, links, xml)
        texts.append("\n".join("".join(node.text or "" for node in iter_namespaces(paragraph, A_NAMESPACES, "t"))
                               for paragraph in iter_namespaces(tree, A_NAMESPACES, "p")))
    return {"slides": len(slides)}, "\n".join(texts)


class TextStream:
    """Consecutive pieces of the newline-joined text corpus, searched as they arrive.

    Only the first and last few characters are retained, enough for a required
    string to span into a neighbouring stream, so memory does not grow with the text.
    """

    def __init__(self, required: tuple[str, ...]):
        self.required = required
        self.window = max((len(text) for text in required), default=0)
        self.pieces = 0
        self.head = ""
        self.tail = ""
        self.length = 0
        self.found: set[str] = set()

    def add(self, piece: str, inside: frozenset[str] = frozenset()) -> None:
        """Append one piece; `inside` names required texts known to occur within it."""
        text = piece if self.pieces == 0 else "\n" + piece
        self.pieces += 1
        if not self.window:
            return
        self.found |= inside
        joined = self.tail + text
        for required in self.required:
            if required not in self.found and required in joined:
                self.found.add(required)
        if len(self.head) < self.window:
            self.head = (self.head + text)[:self.window]
        self.tail = joined[-(self.window - 1):] if self.window > 1 else ""
        self.length += len(text)

    def boundary_text(self) -> str:
        """The stream's text when short, else its head and tail around an unmatchable gap."""
        if self.length <= len(self.head):
            return self.head
        # Command-line arguments cannot contain NUL, so no required text spans the gap;
        # every match inside the elided middle was already found by add().
        return self.head + "\0" + self.tail


class StreamedText:
    """Answer `required in text` for the corpus that ordered TextStreams describe."""

    def __init__(self, streams: list[TextStream]):
        self.found = set().union(*(stream.found for stream in streams))
        self.boundaries = "\n".join(stream.boundary_text() for stream in streams if stream.pieces)

    def __contains__(self, required: str) -> bool:
        return required in self.found or required in self.boundaries


SHARED_STRING_BUDGET = 64 * 1024 * 1024


class SharedStrings:
    """Shared strings reduced to what --contains can still need, in compact storage.

    Each string keeps a bitmask of the required texts it fully contains and, when it is
    longer than the matching window allows, only its first and last window-1 characters
    around a NUL gap. XML text cannot contain NUL, so no required text spans the gap;
    matches across string boundaries therefore stay exact while storage per string is
    bounded by the longest required text instead of the string's length.
    """

    def __init__(self, required: tuple[str, ...], budget: int = SHARED_STRING_BUDGET):
        self.required = required
        self.keep = max((len(text) for text in required), default=1) - 1
        self.mask_bytes = (len(required) + 7) // 8
        self.budget = budget
        self.text = bytearray()
        self.offsets = array("I", [0])
        self.masks = bytearray()

    def __len__(self) -> int:
        return len(self.offsets) - 1

    def append(self, value: str) -> None:
        mask = 0
        for bit, required in enumerate(self.required):
            if required in value:
                mask |= 1 << bit
        if len(value) > 2 * self.keep + 1:
            value = (value[:self.keep] + "\0" + value[len(value) - self.keep:]) if self.keep else "\0"
        self.text += value.encode("utf-8", "surrogatepass")
        self.offsets.append(len(self.text))
        self.masks += mask.to_bytes(self.mask_bytes, "little")
        used = len(self.text) + self.offsets.itemsize * len(self.offsets) + len(self.masks)
        if used > self.budget:
            raise ValueError(
                f"xl/sharedStrings.xml: shared strings needed for --contains exceed the checker's "
                f"{self.budget // (1024 * 1024)} MiB budget; check text with openpyxl read_only=True instead"
            )

    def get(self, index: int) -> tuple[str, frozenset[str]]:
        value = self.text[self.offsets[index]:self.offsets[index + 1]].decode("utf-8", "surrogatepass")
        start = index * self.mask_bytes
        mask = int.from_bytes(self.masks[start:start + self.mask_bytes], "little")
        return value, frozenset(text for bit, text in enumerate(self.required) if mask >> bit & 1)


class DiscardTree:
    """XML parser target that checks well-formedness without building a tree."""

    def start(self, tag, attributes):
        pass

    def end(self, tag):
        pass

    def data(self, data):
        pass

    def close(self):
        return None


def check_well_formed(archive: zipfile.ZipFile, name: str) -> None:
    parser = ET.XMLParser(target=DiscardTree())
    with archive.open(name) as part:
        while chunk := part.read(1 << 20):
            parser.feed(chunk)
    parser.close()


def iter_streamed(archive: zipfile.ZipFile, name: str, supported: tuple[str, ...], drop: set[str]):
    """Yield (namespace, completed element) for a large part, detaching `drop` elements once yielded."""
    stack: list[ET.Element] = []
    uri = None
    with archive.open(name) as part:
        for event, element in ET.iterparse(part, events=("start", "end")):
            if event == "start":
                if uri is None:
                    uri = namespace(element, supported, name)
                stack.append(element)
                continue
            stack.pop()
            yield uri, element
            if stack and element.tag[len(uri):] in drop:
                stack[-1].remove(element)
    if uri is None:
        raise ValueError(f"{name} has no root element")


def inspect_xlsx(xml: dict[str, ET.Element], archive: zipfile.ZipFile, deferred: set[str],
                 required: tuple[str, ...] = ()) -> tuple[dict, StreamedText]:
    part = "xl/workbook.xml"
    links = relationships(part, xml)
    root = xml[part]
    s = namespace(root, S_NAMESPACES, part)
    sheets = []
    streams: list[TextStream] = []
    visited = set()
    # Shared strings and worksheets grow with the workbook, so they are streamed.
    shared_name = "xl/sharedStrings.xml"
    shared_strings = SharedStrings(required)
    shared_count = 0
    if shared_name in deferred:
        visited.add(shared_name)
        for uri, element in iter_streamed(archive, shared_name, S_NAMESPACES, {"si"}):
            if element.tag == f"{uri}si":
                shared_count += 1
                if required:
                    shared_strings.append("".join(node.text or "" for node in element.iter(f"{uri}t")))
    for sheet in root.findall(f"{s}sheets/{s}sheet"):
        reference = relationship_id(sheet, part)
        if reference not in links:
            raise ValueError(f"{part} references missing relationship: {reference}")
        target = links[reference]
        if target not in deferred:
            raise ValueError(f"{part} relationship {reference} targets a non-XML member: {target}")
        visited.add(target)
        cells = formulas = 0
        shared_text, inline_text, string_values = TextStream(required), TextStream(required), TextStream(required)
        for sheet_s, cell in iter_streamed(archive, target, S_NAMESPACES, {"c", "row"}):
            if cell.tag != f"{sheet_s}c":
                continue
            cells += 1
            formulas += cell.find(f"{sheet_s}f") is not None
            if cell.get("t") == "s":
                value = cell.findtext(f"{sheet_s}v", "")
                location = f"{target} cell {cell.get('r', '(no reference)')}"
                try:
                    index = int(value)
                except ValueError as error:
                    raise ValueError(f"{location}: invalid shared string index {value!r}") from error
                if not 0 <= index < shared_count:
                    raise ValueError(f"{location}: shared string index out of range: {index}")
                if required:
                    shared_text.add(*shared_strings.get(index))
            inline_text.add("".join(node.text or "" for node in cell.iter(f"{sheet_s}t")))
            if cell.get("t") == "str":
                string_values.add(cell.findtext(f"{sheet_s}v", ""))
        sheets.append({"name": sheet.attrib["name"], "cells": cells, "formulas": formulas})
        sheet_name = TextStream(required)
        sheet_name.add(sheet.attrib["name"])
        streams.extend([shared_text, inline_text, string_values, sheet_name])
    for name in sorted(deferred - visited):
        check_well_formed(archive, name)
    return {"sheets": sheets, "formulas_evaluated": False}, StreamedText(streams)


def inspect(path: Path, required: tuple[str, ...] = ()) -> tuple[dict, str | StreamedText]:
    """Validate package members and relationships before inspecting the main part."""
    suffix = path.suffix.lower()
    main, content_type = MAIN_PARTS[suffix]
    with zipfile.ZipFile(path) as archive:
        members = archive.namelist()
        if len(members) != len(set(members)):
            raise ValueError("ZIP contains duplicate member names")
        corrupt = archive.testzip()
        if corrupt is not None:
            raise ValueError(f"ZIP member failed its CRC check: {corrupt}")
        names = [name for name in members if name.endswith((".xml", ".rels"))]
        deferred: set[str] = set()
        if suffix == ".xlsx":
            # Workbook parts (worksheets) and shared strings scale with the data:
            # stream them in inspect_xlsx instead of holding every tree at once.
            rels = {name: ET.fromstring(archive.read(name)) for name in names if name.endswith(".rels")}
            deferred = {target for target in relationships(main, rels).values()
                        if target in names and target.endswith(".xml") and target != main}
            deferred |= {"xl/sharedStrings.xml"} & set(names)
        xml = {name: ET.fromstring(archive.read(name)) for name in names if name not in deferred}
        if main not in xml:
            raise ValueError(f"missing main part: {main}")
        types = xml.get("[Content_Types].xml")
        if types is None or not any(node.get("PartName") == "/" + main
                                    and node.get("ContentType", "").endswith(content_type) for node in types):
            raise ValueError(f"[Content_Types].xml does not declare {main} as {suffix}")
        for name, tree in xml.items():
            if not name.endswith(".rels"):
                continue
            source = "" if name == "_rels/.rels" else posixpath.join(posixpath.dirname(posixpath.dirname(name)), posixpath.basename(name)[:-5])
            for rel in tree:
                if rel.get("TargetMode") == "External":
                    continue
                target = relationship_target(source, rel.attrib["Target"])
                if target not in members:
                    raise ValueError(f"{name} references missing package member: {target}")
        if suffix == ".docx":
            return inspect_docx(xml)
        if suffix == ".pptx":
            return inspect_pptx(xml)
        return inspect_xlsx(xml, archive, deferred, tuple(required))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--contains", action="append", default=[], metavar="TEXT")
    parser.add_argument("--count", type=int, help="expected slide or sheet count")
    args = parser.parse_args()
    if args.input.suffix.lower() not in MAIN_PARTS:
        parser.error("input must be .docx, .pptx, or .xlsx; converting the filename does not convert its contents")
    if args.count is not None and (args.count < 0 or args.input.suffix.lower() == ".docx"):
        parser.error("--count must be non-negative and applies only to slides or sheets")
    if args.out is not None and args.out.resolve() == args.input.resolve():
        parser.error("--out must differ from the input document")
    checks = []
    summary = {}
    try:
        summary, text = inspect(args.input, tuple(args.contains))
        checks.append({"id": "package", "status": "pass"})
        for required in args.contains:
            checks.append({"id": "contains", "status": "pass" if required in text else "fail", "text": required})
        if args.count is not None:
            actual = summary.get("slides", len(summary.get("sheets", [])))
            checks.append({"id": "count", "status": "pass" if actual == args.count else "fail", "expected": args.count, "actual": actual})
    except (OSError, ValueError, KeyError, RuntimeError, ET.ParseError, zipfile.BadZipFile, zlib.error) as error:
        checks.append({"id": "package", "status": "fail", "detail": str(error)})
    failed = any(check["status"] == "fail" for check in checks)
    report = {"format": args.input.suffix.lower()[1:], "verdict": "fail" if failed else "pass", "checks": checks, "summary": summary}
    output = json.dumps(report, ensure_ascii=True, indent=2) + "\n"
    if args.out is not None:
        try:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(output, encoding="utf-8")
        except OSError as error:
            failed = True
            report["verdict"] = "fail"
            checks.append({"id": "output", "status": "fail", "detail": str(error)})
            output = json.dumps(report, ensure_ascii=True, indent=2) + "\n"
    sys.stdout.write(output)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
