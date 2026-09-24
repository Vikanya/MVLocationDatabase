#!/usr/bin/env python3
"""Convert the Apps Script export of the "Kpop MV Locations" sheet into flat CSV tables.

Input  (source/export/): index.json, tabs/<gid>.json, links.json   (see tools/export-sheet.gs)
Output (data/):          locations.csv, sets.csv, videos.csv, artists.csv, appearances.csv, review.csv
                         (screenshots/photos are media ids from tools/convert_images.py — run that first)

    python tools/convert_export.py            # parse the export only
    python tools/convert_export.py --online   # also resolve Maps links / addresses to coordinates
                                              # and fetch YouTube titles (cached in source/export)

How the sheet is read:
  * A "header" row (first cell is not a video) starts a new location. A header without a first
    cell (e.g. Columbus "spacerental_09") is another place of the same studio; tags keep them linked.
  * A row of plain labels right under a header (Ametage, provoke Seoul) names the set columns.
  * In a block with X marks, each column is a set: screenshot = filmed there, X = not filmed there.
    Unlabelled set columns are called "Spot N". Links in the header belong to the whole location.
  * Videos after a blank row with no header are a separate, not yet identified location.
  * Locations sharing a Maps or Naver link are merged (e.g. Studio Heal, copied into two tabs).
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import time
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote_plus, urljoin, urlparse

ROOT = Path(__file__).resolve().parent.parent
EXPORT = ROOT / "source" / "export"
OUT = ROOT / "data"
CACHE_FILE = EXPORT / "online-cache.json"

SKIP_TABS = {"Resources", "Racetrack", ""}
USER_AGENT = "MVLocationDatabase-converter/0.1 (personal fan database)"
MEDIA_KINDS = {"youtube", "instagram_post", "imgur"}

# Locations whose website is on one of these domains get the operator's tags
OPERATOR_TAGS = {
    "columbus-studio.kr": ["Columbus"],
    "acres-space.co.kr": ["Acres Space", "Columbus"],  # Acres is run by Columbus Studio
    "mamago-info.com": ["Mamago"],
    "ametage.com": ["Ametage"],
}
# Fixes for header rows, keyed by (tab, row)
LOCATION_FIXES = {
    ("Subway", 1): {"name": "Acres Space – Subway"},  # header was copied from Columbus
    ("Carwash/Gas Station", 14): {"name": "Acres Space – Gas Station"},
}
# Video links missing from the sheet, keyed by (tab, row) of the video row
MISSING_VIDEO_LINKS = {
    ("Abandoned Park", 21): "https://youtu.be/L7HhTKJx0gU",
}
# Reference videos that only belong to one tab's location (copy-pasted into other headers by mistake)
REFERENCE_VIDEO_TAB = {"GZec5w7yvrQ": "Gimcheon campus"}


# --------------------------------------------------------------------------- model


@dataclass
class Cell:
    text: str = ""
    urls: list = field(default_factory=list)
    image: str = ""
    note: str = ""

    @property
    def empty(self):
        return not self.text and not self.urls and not self.image

    @property
    def is_x(self):
        return self.text.strip().upper() == "X" and not self.image


@dataclass(eq=False)
class Location:
    tab: str
    row: int
    name: str = ""
    name_source: str = ""
    address: str = ""
    lat: float | None = None
    lng: float | None = None
    coords_source: str = ""
    maps_urls: list = field(default_factory=list)
    naver_urls: list = field(default_factory=list)
    websites: list = field(default_factory=list)
    instagram: list = field(default_factory=list)
    reference_videos: list = field(default_factory=list)
    photos: list = field(default_factory=list)
    tags: list = field(default_factory=list)
    rows: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    identified: bool = True
    merged_into: Location | None = None
    id: str = ""

    def root(self):
        loc = self
        while loc.merged_into:
            loc = loc.merged_into
        return loc


@dataclass(eq=False)
class Set:
    location: Location
    name: str
    source: str
    website: str = ""
    id: str = ""


@dataclass(eq=False)
class Video:
    key: str
    platform: str
    url: str
    title_sheet: str = ""
    title: str = ""
    channel: str = ""
    status: str = ""
    timestamp: int | None = None


@dataclass(eq=False)
class Appearance:
    video: Video
    location: Location
    set: Set | None
    screenshots: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    confidence: str = ""
    rows: list = field(default_factory=list)


class Db:
    def __init__(self):
        self.locations: list[Location] = []
        self.sets: list[Set] = []
        self.videos: dict[str, Video] = {}
        self.appearances: list[Appearance] = []
        self.review: list[dict] = []
        self.aliases: list[tuple] = []  # (tab, row, target gid, target row)

    def flag(self, tab, row, issue, detail=""):
        self.review.append({"tab": tab, "row": row, "issue": issue, "detail": detail})

    def get_set(self, location, name, source, website=""):
        for s in self.sets:
            if s.location is location and s.name == name:
                return s
        s = Set(location, name, source, website)
        self.sets.append(s)
        return s

    def get_video(self, url, title):
        kind = url_kind(url)
        if kind == "youtube":
            key, ts = youtube_id(url)
        elif kind == "instagram_post":
            key, ts = "ig-" + urlparse(url).path.strip("/").split("/")[-1], None
        else:
            key, ts = "imgur-" + urlparse(url).path.strip("/").split("/")[-1], None
        video = self.videos.get(key)
        if not video:
            canonical = f"https://www.youtube.com/watch?v={key}" if kind == "youtube" else url
            video = self.videos[key] = Video(key, kind, canonical, timestamp=ts)
        if title and not video.title_sheet:
            video.title_sheet = title
        return video


# --------------------------------------------------------------------------- url helpers


def url_kind(url):
    if url.startswith("#gid="):
        return "sheet"
    p = urlparse(url)
    host = re.sub(r"^(www\.|m\.)", "", p.netloc.lower())
    if host in ("youtu.be", "youtube.com"):
        return "youtube"
    if host == "maps.app.goo.gl" or (host == "goo.gl" and p.path.startswith("/maps")) or (
        host.startswith("google.") and p.path.startswith("/maps")
    ) or host == "maps.google.com":
        return "maps"
    if host in ("naver.me", "map.naver.com"):
        return "naver"
    if host == "instagram.com":
        return "instagram_post" if re.match(r"/(p|reel)/", p.path) else "instagram"
    if host == "imgur.com":
        return "imgur"
    if host == "docs.google.com" and "/spreadsheets/" in p.path:
        return "sheet"
    return "web"


def youtube_id(url):
    p = urlparse(url)
    q = parse_qs(p.query)
    if p.netloc.endswith("youtu.be"):
        vid = p.path.strip("/").split("/")[0]
    elif "v" in q:
        vid = q["v"][0]
    else:
        vid = p.path.rstrip("/").split("/")[-1]
    ts = None
    if "t" in q:
        m = re.match(r"(\d+)", q["t"][0])
        ts = int(m.group(1)) if m else None
    return vid, ts


def sheet_link_target(url):
    """'#gid=771300346&range=A7' or a full sheet URL -> (gid, row)."""
    frag = url.split("#", 1)[-1]
    gid = re.search(r"gid=(\d+)", frag)
    row = re.search(r"range=[A-Z]+(\d+)", frag)
    return (int(gid.group(1)) if gid else None, int(row.group(1)) if row else 1)


def media_urls(cell):
    return [u for u in cell.urls if url_kind(u) in MEDIA_KINDS]


# --------------------------------------------------------------------------- text helpers

DMS_RE = re.compile(
    r"(\d+)°\s*(\d+)'\s*([\d.]+)\"\s*([NS])\s+(\d+)°\s*(\d+)'\s*([\d.]+)\"\s*([EW])"
)
ADDRESS_MARKERS = re.compile(
    r"(-ro\b|-gil\b|-dong\b|-ri\b|-gu\b|-si\b|-do\b|-myeon\b|-eup\b|korea|corée|usa|united states"
    r"|\bca \d|seoul|incheon|district|[가-힣]+(로|길|동|리|구|시|층)\b)",
    re.I,
)
VIDEOISH = re.compile(r" - |\bM/?V\b|Official|Performance|Music Video|[‘\"“「]")


def meaningful(text):
    return bool(re.search(r"\w", text)) and text.strip() not in {"?"}


def looks_like_address(text):
    if not ADDRESS_MARKERS.search(text):
        return False
    return bool(re.search(r"\d", text)) or text.count(",") >= 2


def parse_dms(text):
    m = DMS_RE.search(text)
    if not m:
        return None
    d1, m1, s1, ns, d2, m2, s2, ew = m.groups()
    lat = int(d1) + int(m1) / 60 + float(s1) / 3600
    lng = int(d2) + int(m2) / 60 + float(s2) / 3600
    return (-lat if ns == "S" else lat, -lng if ew == "W" else lng)


def clean_title(text):
    text = " ".join(text.split())
    return re.sub(r"\s*-\s*YouTube\s*$", "", text)


def slugify(text):
    text = unicodedata.normalize("NFKC", text).lower()
    text = "".join(ch if "가" <= ch <= "힣" else unicodedata.normalize("NFKD", ch)[0] for ch in text)
    return re.sub(r"[^0-9a-z가-힣]+", "-", text).strip("-")[:60].strip("-")


def has_hangul(text):
    return bool(re.search(r"[가-힣]", text))


def latin_part(text):
    """First run of Latin words: 'NCT 127 엔시티 127' -> 'NCT 127', '瑪菲司Mavis' -> 'Mavis'."""
    words = []
    for token in text.split():
        if re.fullmatch(r"[\x20-\x7E]+", token):
            words.append(token)
            continue
        ascii_bit = "" if has_hangul(token) else re.sub(r"[^\x20-\x7E]+", "", token)
        if len(re.findall(r"[A-Za-z]", ascii_bit)) >= 2:
            words.append(ascii_bit)
        elif words:
            break
    return " ".join(words).strip(" '’\"“”.,:;-_/|")


def hangul_part(text):
    return " ".join(t for t in text.split() if has_hangul(t)).strip(" '’\"“”.,:;-_/|")


# --------------------------------------------------------------------------- title parsing

TAG_RE = re.compile(
    r"^(?:m/?v|official m/?v|live|live clip|special|special clip|special performance|4k|in the studio"
    r"|eng|fix off|play music ground|station : nct lab|the 8 contemporary art|fl.?ylist|#.*"
    r"|.*(?:퍼포먼스|퀸덤퍼즐|스우파|하이라이트|무슈스).*)$",
    re.I,
)
LEAD_BRACKET = re.compile(r"^\s*([\[［【(（])([^\]］】)）]*)([\]］】)）])\s*")
ARTIST_END = re.compile(
    r"\s+[-–—_|│｜]\s+|\)[-_]|\s+l\s+|[\s)’]['‘\"“]|「|［|【|\s\[|\s*\(?\bfeat\b|\s\bft\.|\s*｜",
    re.I,
)
QUOTED = re.compile(r"['‘\"“「［\[]([^'’\"”」］\]]{1,80})['’\"”」］\]]")


def split_name(raw):
    """'BLITZERS(블리처스)' / '퍼플키스(PURPLE KISS)' / 'NCT DREAM 엔시티 드림' -> (latin, hangul)."""
    raw = raw.strip(" '’\"“”.,:;-_/|")
    outer, groups, depth, buf, i = "", [], 0, "", 0
    while i < len(raw):
        ch = raw[i]
        if ch in "(（":
            if depth == 0:
                buf = ""
            else:
                buf += ch
            depth += 1
        elif ch in ")）" and depth:
            depth -= 1
            if depth == 0:
                # "(여자)아이들": a group glued to the following text belongs to the name itself
                if i + 1 < len(raw) and raw[i + 1] not in " (（":
                    outer += f"({buf})"
                else:
                    groups.append(buf)
            else:
                buf += ch
        elif depth:
            buf += ch
        else:
            outer += ch
        i += 1
    parts = [outer.strip()] + [g.strip() for g in groups]
    latin = next((latin_part(p) for p in parts if latin_part(p) and not has_hangul(p)), "")
    if not latin:
        latin = next((latin_part(p) for p in parts if latin_part(p)), "")
    hangul = next((p.strip() for p in parts if has_hangul(p)), "")
    if hangul and latin and latin in hangul:
        hangul = hangul_part(hangul)
    return latin, hangul


def parse_title(title):
    """Best-effort: title -> (artists [(latin, hangul)], song, type)."""
    t = clean_title(title)
    low = t.lower()
    if re.search(r"\bcover\b", low):
        kind = "cover"
    elif re.search(r"\bm/?v\b|music video|뮤직\s?비디오|official video", low):
        kind = "mv"
    elif re.search(r"performance|퍼포먼스|dance|choreograph|안무", low):
        kind = "performance"
    elif re.search(r"\blive\b|라이브", low):
        kind = "live"
    elif re.search(r"special|clip|film|trailer", low):
        kind = "clip"
    else:
        kind = "other"

    m = re.match(r"^Cover by (\S+)", t, re.I)
    if m:
        return [(m.group(1), "")], "", kind

    artist_raw, rest = "", t
    rest = re.sub(r"^(?:M/?V|MV)\s*[|:]\s*", "", rest)
    while True:
        m = LEAD_BRACKET.match(rest)
        if not m:
            break
        inner = m.group(2).strip()
        if TAG_RE.match(inner):
            rest = rest[m.end():]
        elif m.group(1) in "[［【" and not artist_raw:
            artist_raw, rest = inner, rest[m.end():]
        else:
            break
    if not artist_raw:
        end = ARTIST_END.search(rest)
        if end and end.start() > 0:
            artist_raw, rest = rest[: end.start() + (1 if rest[end.start()] in ")’" else 0)], rest[end.start():]
    artist_raw = re.split(r"\s+(?:feat\.?|ft\.)\s", artist_raw, flags=re.I)[0]

    artists = []
    # "A X B" is a collaboration, but "MONSTA X" is a name
    for part in re.split(r"\s*&\s*|\s*,\s*|(?<!MONSTA)\s+[Xx]\s+", artist_raw):
        latin, hangul = split_name(part)
        if latin or hangul:
            artists.append((latin, hangul))

    q = QUOTED.search(rest)
    song = q.group(1).strip() if q else ""
    return artists, song, kind


# --------------------------------------------------------------------------- parsing the export


def load_tab(tab, gid, links):
    data = json.loads((EXPORT / "tabs" / f"{gid}.json").read_text(encoding="utf-8"))
    cells = {}
    for c in data["cells"]:
        cells[(c["r"], c["c"])] = Cell(c.get("text", "").strip(), [], c.get("image", ""), c.get("note", ""))
    for c in links.get(str(gid), []):
        cells.setdefault((c["r"], c["c"]), Cell()).urls = c["urls"]
    for (fix_tab, r), url in MISSING_VIDEO_LINKS.items():
        if fix_tab == tab:
            cell = cells.setdefault((r, 1), Cell())
            if not cell.urls:
                cell.urls = [url]
    return cells


def row_type(row):
    first = row.get(1)
    if first and media_urls(first):
        return "video"
    others = {c: cell for c, cell in row.items() if c >= 2}
    if (not first or not meaningful(first.text) or any(url_kind(u) == "sheet" for u in first.urls)) and len(
        [c for c in others.values() if c.text and not c.urls and not c.image and not c.is_x]
    ) >= 2 and not any(c.image for c in others.values()):
        return "setnames"
    if not first and any(c.image or c.is_x for c in others.values()) and not any(c.urls for c in others.values()):
        return "orphan"
    if first and first.text and not first.urls and not others and VIDEOISH.search(first.text):
        return "video_nolink"
    return "header"


def parse_header(db, tab, r, row, current):
    """Returns ('location', Location) | ('set', Set) | ('alias', None)."""
    loc = Location(tab, r, tags=[tab], rows=[f"{tab}!{r}"])
    set_label, set_site, sheet_links, has_first = "", "", [], 1 in row
    for c, cell in sorted(row.items()):
        if cell.image:
            loc.photos.append(cell.image)
        if cell.note:
            loc.notes.append(cell.note)
        for u in cell.urls:
            kind = url_kind(u)
            if kind == "maps":
                loc.maps_urls.append(u)
            elif kind == "naver":
                loc.naver_urls.append(u)
            elif kind in ("instagram", "instagram_post"):
                loc.instagram.append(u)
            elif kind == "youtube":
                loc.reference_videos.append(u)
            elif kind == "sheet":
                sheet_links.append(u)
            else:
                loc.websites.append(u)
        text = cell.text
        if not text or text.startswith("http") or any(url_kind(u) == "youtube" for u in cell.urls):
            continue
        if not meaningful(text):
            continue
        dms = parse_dms(text)
        if dms:
            loc.lat, loc.lng, loc.coords_source = dms[0], dms[1], "sheet (DMS)"
        elif looks_like_address(text):
            if len(text) > len(loc.address):
                loc.address = " ".join(text.split())
        elif not loc.name:
            loc.name, loc.name_source = " ".join(text.split()), "sheet"
            set_label = loc.name
        else:
            loc.notes.append(text)

    if sheet_links and not (loc.maps_urls or loc.naver_urls or loc.address):
        gid, target_row = sheet_link_target(sheet_links[0])
        db.aliases.append((tab, r, gid, target_row, loc.name))
        return "alias", None

    if not has_first and current and not (loc.maps_urls or loc.naver_urls or loc.address or loc.lat):
        # another place run by the same studio / agency (Columbus "spacerental_09", Mamago "피라미드")
        site = loc.websites[0] if loc.websites else ""
        label = set_label or (unquote_plus(urlparse(site).path.strip("/").split("/")[-1]) if site else f"row {r}")
        loc.name, loc.name_source = f"{tab} – {label}", "sub-header"

    loc.identified = bool(loc.name or loc.maps_urls or loc.naver_urls or loc.address or loc.lat)
    db.locations.append(loc)
    return "location", loc


def parse_tab(db, tab, cells, nrows, ncols):
    rows = {r: {c: cells[(r, c)] for c in range(1, ncols + 1) if (r, c) in cells and not cells[(r, c)].empty}
            for r in range(1, nrows + 1)}
    types = {r: (row_type(row) if row else "blank") for r, row in rows.items()}

    current = None      # Location the next videos belong to
    set_names = {}      # column -> set name, from a label row under the header
    prev_type = "blank"

    r = 1
    while r <= nrows:
        t = types[r]
        if t == "blank":
            prev_type = "blank"
            r += 1
            continue

        if t == "header":
            kind, obj = parse_header(db, tab, r, rows[r], current)
            if kind == "location":
                current = obj
            set_names, prev_type = {}, "header"
            r += 1
            continue

        if t == "setnames":
            set_names = {c: cell.text for c, cell in rows[r].items() if c >= 2 and cell.text}
            prev_type = "header"
            r += 1
            continue

        # a block of video rows: until the next blank or header row
        block = []
        while r <= nrows and types[r] in ("video", "orphan", "video_nolink"):
            block.append(r)
            r += 1

        if prev_type == "blank" or current is None:
            # a group of videos with no header is a separate place that hasn't been identified yet
            current = Location(tab, block[0], tags=[tab], rows=[f"{tab}!{block[0]}"], identified=False)
            db.locations.append(current)
            set_names = {}

        parse_block(db, tab, block, rows, types, current, set_names)
        prev_type = "video"


def parse_block(db, tab, block, rows, types, loc, set_names):
    video_rows = [r for r in block if types[r] == "video"]
    x_cols = {c for r in video_rows for c, cell in rows[r].items() if c >= 2 and cell.is_x}
    grid_cols = set(set_names) | x_cols
    if grid_cols:
        # screenshot columns inside the grid are sets too; ones to the right of it are extra screenshots
        last = max(grid_cols)
        grid_cols |= {c for r in video_rows for c, cell in rows[r].items() if 2 <= c <= last and cell.image}
    grid_cols = sorted(grid_cols)
    sets_by_col = {}
    for i, c in enumerate(grid_cols, 1):
        if c in set_names:
            sets_by_col[c] = db.get_set(loc, set_names[c], "column label")
        else:
            sets_by_col[c] = db.get_set(loc, f"Spot {i}", "unlabelled column")

    for r in block:
        row, t = rows[r], types[r]
        if t == "orphan":
            db.flag(tab, r, "screenshot without a video", "row has screenshots or X marks but no video link")
            continue
        if t == "video_nolink":
            db.flag(tab, r, "video without a link", f"'{row[1].text}' — add the YouTube link")
            continue

        first = row[1]
        urls = media_urls(first)
        title = "" if first.text.startswith("http") else clean_title(first.text)
        if len(urls) > 1:
            db.flag(tab, r, "several videos in one cell", " | ".join(urls))
        notes, confidence = [], ""
        if first.note:
            notes.append(first.note)
        for c, cell in row.items():
            if c >= 2 and cell.text and not cell.is_x and not cell.image:
                notes.append(cell.text)
                if re.search(r"pas s[uû]r|not sure|unsure|\?", cell.text, re.I):
                    confidence = "unsure"

        for url in urls:
            video = db.get_video(url, title)
            if not grid_cols:
                shots = [row[c].image for c in sorted(row) if c >= 2 and row[c].image]
                add_appearance(db, video, loc, None, shots, notes, confidence, f"{tab}!{r}")
                continue
            made = []
            for c in grid_cols:
                cell = row.get(c)
                if cell and cell.image:
                    made.append(add_appearance(db, video, loc, sets_by_col[c], [cell.image], notes, confidence, f"{tab}!{r}"))
            extras = [row[c].image for c in sorted(row) if c >= 2 and c not in grid_cols and row[c].image]
            if made and extras:
                made[0].screenshots += extras
            elif not made:
                add_appearance(db, video, loc, None, extras, notes, confidence, f"{tab}!{r}")
                if not extras:
                    db.flag(tab, r, "every set marked X", f"'{title or url}' has no screenshot in any set column")


def add_appearance(db, video, loc, set_, shots, notes, confidence, source):
    for a in db.appearances:
        if a.video is video and a.location is loc and a.set is set_:
            break
    else:
        a = Appearance(video, loc, set_)
        db.appearances.append(a)
    a.screenshots += [s for s in shots if s not in a.screenshots]
    a.notes += [n for n in notes if n not in a.notes]
    a.confidence = a.confidence or confidence
    if source not in a.rows:
        a.rows.append(source)
    return a


# --------------------------------------------------------------------------- post-processing


def merge_locations(db):
    by_link = {}
    for loc in db.locations:
        for link in loc.maps_urls + loc.naver_urls:
            other = by_link.get(link)
            if other and other.root() is not loc.root():
                keep, drop = other.root(), loc.root()
                drop.merged_into = keep
                for attr in ("maps_urls", "naver_urls", "websites", "instagram", "reference_videos", "photos",
                             "tags", "rows", "notes"):
                    getattr(keep, attr).extend(v for v in getattr(drop, attr) if v not in getattr(keep, attr))
                keep.name = keep.name or drop.name
                keep.address = keep.address or drop.address
                db.flag(drop.tab, drop.row, "duplicate location merged", f"same link as {keep.tab}!{keep.row}")
            by_link.setdefault(link, loc)

    for s in db.sets:
        s.location = s.location.root()
    merged = {}
    for a in db.appearances:
        a.location = a.location.root()
        key = (a.video.key, id(a.location), id(a.set))
        if key in merged:
            m = merged[key]
            m.screenshots += [s for s in a.screenshots if s not in m.screenshots]
            m.notes += [n for n in a.notes if n not in m.notes]
            m.rows += [r for r in a.rows if r not in m.rows]
            m.confidence = m.confidence or a.confidence
        else:
            merged[key] = a
    db.appearances = list(merged.values())
    db.locations = [loc for loc in db.locations if not loc.merged_into]


def apply_aliases(db, gid_to_tab):
    for tab, r, gid, target_row, label in db.aliases:
        target_tab = gid_to_tab.get(gid)
        candidates = sorted((loc for loc in db.locations if loc.tab == target_tab and loc.row >= target_row),
                            key=lambda loc: loc.row)
        if not candidates:
            db.flag(tab, r, "link to another tab not resolved", f"'{label}' → {target_tab} row {target_row}")
            continue
        loc = candidates[0]
        if tab not in loc.tags:
            loc.tags.append(tab)
        db.flag(tab, r, "link to another tab", f"'{label}' → '{loc.name or loc.address}' is also listed under {tab}")


def finalize(db, tab_order):
    used = set()

    def unique(base):
        base = base or "item"
        slug, n = base, 2
        while slug in used:
            slug, n = f"{base}-{n}", n + 1
        used.add(slug)
        return slug

    # headers that hold neither a place nor videos (e.g. a tab-wide PDF link)
    for loc in [l for l in db.locations if not l.identified]:
        if not any(a.location is loc for a in db.appearances):
            links = join(loc.websites + loc.reference_videos + loc.instagram)
            db.flag(loc.tab, loc.row, "header ignored", f"no place and no videos: {links or loc.notes}")
            db.locations.remove(loc)

    for loc in db.locations:
        for key, value in LOCATION_FIXES.get((loc.tab, loc.row), {}).items():
            setattr(loc, key, value)
            if key == "name":
                loc.name_source = "fix"
        loc.reference_videos = [u for u in loc.reference_videos
                                if REFERENCE_VIDEO_TAB.get(youtube_id(u)[0], loc.tab) == loc.tab]
        for site in loc.websites:
            host = re.sub(r"^www\.", "", urlparse(site).netloc.lower())
            loc.tags += [t for t in OPERATOR_TAGS.get(host, []) if t not in loc.tags]

    # fallback names
    for tab in tab_order:
        in_tab = [loc for loc in db.locations if loc.tab == tab and not loc.name]
        for k, loc in enumerate(in_tab, 1):
            loc.name = tab if len(in_tab) == 1 and len([l for l in db.locations if l.tab == tab]) == 1 else f"{tab} #{k}"
            loc.name_source = "tab name"
    for loc in db.locations:
        loc.tags = [t for t in loc.tags if t != loc.name]

    db.locations.sort(key=lambda loc: (tab_order.index(loc.tab), loc.row))
    for loc in db.locations:
        # "더샵스타시티 The Sharp Star City" -> the-sharp-star-city, otherwise the whole name
        latin = latin_part(loc.name)
        use_latin = has_hangul(loc.name) and len(latin.split()) >= 2
        loc.id = unique(slugify(latin) if use_latin else slugify(loc.name))
    for loc in db.locations:
        if not loc.identified:
            db.flag(loc.tab, loc.row, "location not identified", f"{loc.id}: no name, address or map link")
        elif loc.lat is None:
            db.flag(loc.tab, loc.row, "no coordinates", f"{loc.id}: add a Google Maps link or lat/lng")
        if not any(a.location is loc for a in db.appearances):
            db.flag(loc.tab, loc.row, "location without videos", f"{loc.id}: {loc.name}")

    for s in db.sets:
        s.id = unique(f"{s.location.id}--{slugify(s.name) or 'set'}")

    artists, video_artists = {}, {}
    for video in db.videos.values():
        parsed, song, kind = parse_title(video.title or video.title_sheet)
        ids = []
        for latin, hangul in parsed:
            aid = slugify(latin) or slugify(hangul)
            if not aid:
                continue
            entry = artists.setdefault(aid, {"artist_id": aid, "name": latin or hangul, "name_ko": "", "videos": 0})
            entry["name_ko"] = entry["name_ko"] or hangul
            entry["videos"] += 1
            ids.append(aid)
        video_artists[video.key] = (ids, song, kind)
        if not ids:
            db.flag("", "", "artist not recognised", f"{video.key}: {video.title or video.title_sheet}")
    return artists, video_artists


# --------------------------------------------------------------------------- online enrichment


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _redirect_target(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        _opener.open(req, timeout=20).close()
        return None
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            return urljoin(url, e.headers.get("Location", ""))
        raise


def resolve_maps(url):
    current = url
    for _ in range(6):
        p = urlparse(current)
        if "consent.google" in p.netloc:
            current = parse_qs(p.query).get("continue", [current])[0]
            break
        if p.netloc.startswith(("www.google.", "google.", "maps.google.")) and (
            p.path.startswith("/maps") or "q=" in p.query or "cid=" in p.query
        ):
            break
        nxt = _redirect_target(current)
        if not nxt:
            break
        current = nxt
    return {"final": current}


def parse_maps_url(url):
    """Coordinates / place name from an expanded Google Maps URL (place, dropped pin or ?q= search)."""
    result = {}
    m = (re.search(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", url)
         or re.search(r"/maps/search/(-?\d+\.\d+),\+?(-?\d+\.\d+)", url)
         or re.search(r"@(-?\d+\.\d+),(-?\d+\.\d+)", url))
    if not m:
        q = parse_qs(urlparse(url).query).get("q", [""])[0]
        m = re.match(r"\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)", q)
        if q and not m:
            result["query"] = q
    if m:
        result["lat"], result["lng"] = float(m.group(1)), float(m.group(2))
    place = re.search(r"/maps/place/([^/@?]+)", url)
    if place:
        result["place"] = unquote_plus(place.group(1))
    return result


def oembed(key):
    url = "https://www.youtube.com/oembed?format=json&url=" + quote(f"https://www.youtube.com/watch?v={key}", safe="")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.load(res)
        return {"status": "ok", "title": data.get("title", ""), "channel": data.get("author_name", "")}
    except urllib.error.HTTPError as e:
        return {"status": f"http {e.code}"}


def geocode(address):
    url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + quote(address)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as res:
        hits = json.load(res)
    time.sleep(1.1)  # Nominatim usage policy: max 1 request per second
    return {"lat": float(hits[0]["lat"]), "lng": float(hits[0]["lon"]), "label": hits[0]["display_name"]} if hits else {}


def enrich_online(db):
    cache = json.loads(CACHE_FILE.read_text(encoding="utf-8")) if CACHE_FILE.exists() else {}
    for section in ("maps", "oembed", "geocode"):
        cache.setdefault(section, {})

    def cached(section, keys, fn, workers):
        todo = [k for k in keys if k not in cache[section]]
        if todo:
            print(f"  {section}: fetching {len(todo)}…")

            def run(k):
                try:
                    return k, fn(k)
                except (urllib.error.URLError, OSError, ValueError) as e:
                    print(f"    ! {k}: {e}")
                    return k, None

            with ThreadPoolExecutor(workers) as pool:
                for k, value in pool.map(run, todo):
                    if value is not None:
                        cache[section][k] = value
            CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")

    cached("maps", sorted({u for loc in db.locations for u in loc.maps_urls}), resolve_maps, 6)
    cached("oembed", sorted(k for k, v in db.videos.items() if v.platform == "youtube"), oembed, 8)
    for loc in db.locations:
        for u in loc.maps_urls:
            info = parse_maps_url(cache["maps"].get(u, {}).get("final", ""))
            if loc.lat is None and "lat" in info:
                loc.lat, loc.lng, loc.coords_source = info["lat"], info["lng"], "google maps link"
            if not loc.name and info.get("place"):
                loc.name, loc.name_source = info["place"], "google maps"
            if not loc.address and info.get("query") and looks_like_address(info["query"]):
                loc.address = info["query"]
    cached("geocode", sorted({loc.address for loc in db.locations if loc.lat is None and loc.address}), geocode, 1)
    for loc in db.locations:
        info = cache["geocode"].get(loc.address, {}) if loc.lat is None else {}
        if "lat" in info:
            loc.lat, loc.lng, loc.coords_source = info["lat"], info["lng"], "address lookup (approximate)"
    for video in db.videos.values():
        info = cache["oembed"].get(video.key)
        if info:
            video.status = info["status"]
            video.title = info.get("title", "")
            video.channel = info.get("channel", "")
            if info["status"] != "ok":
                db.flag("", "", "video not embeddable or gone", f"{video.key} ({info['status']}): {video.title_sheet}")


# --------------------------------------------------------------------------- output


def write_csv(name, header, rows):
    OUT.mkdir(exist_ok=True)
    with open(OUT / name, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def join(values):
    return " ; ".join(str(v) for v in values if v)


def load_image_map():
    """Export image names -> media ids from tools/convert_images.py (export names kept if it hasn't run)."""
    path = EXPORT / "image-map.json"
    if not path.exists():
        print("! source/export/image-map.json missing — run tools/convert_images.py; keeping export image names")
        return lambda names: names
    mapping = json.loads(path.read_text(encoding="utf-8"))

    def to_media(names):
        out = []
        for name in names:
            mid = mapping.get(name, name)
            if mid not in out:
                out.append(mid)
        return out

    return to_media


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--online", action="store_true", help="resolve Maps links/addresses and fetch YouTube titles")
    args = parser.parse_args()

    index = json.loads((EXPORT / "index.json").read_text(encoding="utf-8"))
    links = json.loads((EXPORT / "links.json").read_text(encoding="utf-8"))
    db = Db()
    tab_order = []
    for t in index:
        if t["name"].strip() in SKIP_TABS:
            continue
        tab_order.append(t["name"])
        parse_tab(db, t["name"], load_tab(t["name"], t["gid"], links), t["rows"], t["cols"])

    merge_locations(db)
    apply_aliases(db, {t["gid"]: t["name"] for t in index})
    if args.online:
        print("Online lookups:")
        enrich_online(db)
    artists, video_artists = finalize(db, tab_order)
    media = load_image_map()

    write_csv("locations.csv",
              ["location_id", "name", "name_source", "identified", "address", "lat", "lng", "coords_source",
               "maps_url", "naver_url", "website", "instagram", "reference_videos", "photos", "tags",
               "source_rows", "notes"],
              [[l.id, l.name, l.name_source, "yes" if l.identified else "no", l.address,
                "" if l.lat is None else round(l.lat, 6), "" if l.lng is None else round(l.lng, 6), l.coords_source,
                join(l.maps_urls), join(l.naver_urls), join(l.websites), join(l.instagram),
                join(l.reference_videos), join(media(l.photos)), join(l.tags), join(l.rows),
                join(l.notes)] for l in db.locations])
    write_csv("sets.csv", ["set_id", "location_id", "name", "source", "website"],
              [[s.id, s.location.id, s.name, s.source, s.website] for s in db.sets])
    write_csv("videos.csv",
              ["video_id", "platform", "url", "title", "title_in_sheet", "channel", "artist_ids", "song", "type",
               "status"],
              [[v.key, v.platform, v.url, v.title or v.title_sheet, v.title_sheet, v.channel,
                join(video_artists[v.key][0]), video_artists[v.key][1], video_artists[v.key][2], v.status]
               for v in db.videos.values()])
    write_csv("artists.csv", ["artist_id", "name", "name_ko", "video_count"],
              [[a["artist_id"], a["name"], a["name_ko"], a["videos"]]
               for a in sorted(artists.values(), key=lambda a: a["artist_id"])])
    write_csv("appearances.csv",
              ["video_id", "location_id", "set_id", "screenshots", "timestamp", "confidence", "notes", "source_rows"],
              [[a.video.key, a.location.id, a.set.id if a.set else "", join(media(a.screenshots)),
                a.video.timestamp or "", a.confidence, join(a.notes), join(a.rows)] for a in db.appearances])
    order = {t: i for i, t in enumerate(tab_order)}
    db.review.sort(key=lambda x: (order.get(x["tab"], 999), x["row"] if isinstance(x["row"], int) else 0))
    write_csv("review.csv", ["tab", "row", "issue", "detail"],
              [[x["tab"], x["row"], x["issue"], x["detail"]] for x in db.review])

    located = sum(1 for l in db.locations if l.lat is not None)
    print(f"{len(db.locations)} locations ({located} with coordinates), {len(db.sets)} sets, "
          f"{len(db.videos)} videos, {len(artists)} artists, {len(db.appearances)} appearances, "
          f"{len(db.review)} review items → {OUT}")


if __name__ == "__main__":
    main()
