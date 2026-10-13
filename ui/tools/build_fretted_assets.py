"""Generate the unbranded guitar and bass GLBs with Python's standard library."""

from __future__ import annotations

import json
import math
import random
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "public" / "models"
STYLES = ["Realistic", "ClayStudyModel", "NeonRhythm", "TechnicalBlueprint"]
BODY_DOME = 0.0055
PITCH_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]
VARIANT_TINTS = {
    "Realistic": (1.0, 1.0, 1.0),
    "ClayStudyModel": (1.04, 0.97, 0.91),
    "NeonRhythm": (0.48, 0.72, 1.12),
    "TechnicalBlueprint": (0.66, 0.82, 0.96),
}


@dataclass
class Mesh:
    p: list[tuple[float, float, float]]
    n: list[tuple[float, float, float]]
    uv: list[tuple[float, float]]
    tri: list[tuple[int, int, int]]

    @classmethod
    def empty(cls) -> "Mesh":
        return cls([], [], [], [])

    def vertex(self, point, normal=(0, 0, 1), uv=(0, 0)) -> int:
        self.p.append(tuple(point))
        self.n.append(tuple(normal))
        self.uv.append(tuple(uv))
        return len(self.p) - 1

    def triangle(self, a: int, b: int, c: int):
        self.tri.append((a, b, c))

    def quad(self, a: int, b: int, c: int, d: int):
        self.triangle(a, b, c)
        self.triangle(a, c, d)

    def append(self, other: "Mesh"):
        offset = len(self.p)
        self.p.extend(other.p)
        self.n.extend(other.n)
        self.uv.extend(other.uv)
        self.tri.extend(tuple(i + offset for i in tri) for tri in other.tri)


def normalize(v):
    length = math.sqrt(sum(x * x for x in v)) or 1
    return tuple(x / length for x in v)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def lerp(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def catmull(points, steps=8):
    out = []
    count = len(points)
    for i in range(count):
        p0, p1, p2, p3 = (points[(i + j) % count] for j in (-1, 0, 1, 2))
        for step in range(steps):
            t = step / steps
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * (
                2 * p1[k] + (-p0[k] + p2[k]) * t +
                (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
                (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3
            ) for k in range(len(p1))))
    return out


def box(center, size, *, bevel=0):
    m = Mesh.empty()
    x, y, z = center
    sx, sy, sz = (v / 2 for v in size)
    faces = [
        ((1, 0, 0), [(sx, -sy, -sz), (sx, sy, -sz), (sx, sy, sz), (sx, -sy, sz)]),
        ((-1, 0, 0), [(-sx, -sy, -sz), (-sx, -sy, sz), (-sx, sy, sz), (-sx, sy, -sz)]),
        ((0, 1, 0), [(-sx, sy, -sz), (-sx, sy, sz), (sx, sy, sz), (sx, sy, -sz)]),
        ((0, -1, 0), [(-sx, -sy, -sz), (sx, -sy, -sz), (sx, -sy, sz), (-sx, -sy, sz)]),
        ((0, 0, 1), [(-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz)]),
        ((0, 0, -1), [(-sx, sy, -sz), (sx, sy, -sz), (sx, -sy, -sz), (-sx, -sy, -sz)]),
    ]
    for normal, corners in faces:
        if bevel:
            steps = 2
            half = (sx, sy, sz)
            for i in range(steps + 1):
                u = i / steps
                for j in range(steps + 1):
                    v = j / steps
                    point = tuple(
                        corners[0][axis] * (1 - u) * (1 - v) +
                        corners[1][axis] * u * (1 - v) +
                        corners[2][axis] * u * v +
                        corners[3][axis] * (1 - u) * v
                        for axis in range(3))
                    core = tuple(max(-half[k] + bevel, min(half[k] - bevel, point[k])) for k in range(3))
                    delta = tuple(point[k] - core[k] for k in range(3))
                    smooth_normal = normalize(delta)
                    m.vertex(tuple((x, y, z)[k] + core[k] + smooth_normal[k] * bevel for k in range(3)),
                        smooth_normal, (u, v))
            first = len(m.p) - (steps + 1) ** 2
            for i in range(steps):
                for j in range(steps):
                    a = first + i * (steps + 1) + j
                    m.quad(a, a + steps + 1, a + steps + 2, a + 1)
            continue
        ids = [m.vertex((x + a, y + b, z + c), normal, (i % 2, i // 2)) for i, (a, b, c) in enumerate(corners)]
        m.quad(*ids)
    return m


def cylinder(start, end, radius, sides=12, r2=None):
    m = Mesh.empty()
    r2 = radius if r2 is None else r2
    axis = normalize(tuple(end[i] - start[i] for i in range(3)))
    ref = (0, 0, 1) if abs(axis[2]) < 0.9 else (0, 1, 0)
    u = normalize(cross(axis, ref))
    v = normalize(cross(axis, u))
    rings = []
    for point, rad in ((start, radius), (end, r2)):
        ring = []
        for j in range(sides):
            angle = 2 * math.pi * j / sides
            radial = tuple(u[k] * math.cos(angle) + v[k] * math.sin(angle) for k in range(3))
            ring.append(m.vertex(tuple(point[k] + radial[k] * rad for k in range(3)), radial, (j / sides, 0 if point == start else 1)))
        rings.append(ring)
    for j in range(sides):
        k = (j + 1) % sides
        m.quad(rings[0][j], rings[0][k], rings[1][k], rings[1][j])
    for ring, point, direction in ((rings[0], start, -1), (rings[1], end, 1)):
        center = m.vertex(point, tuple(c * direction for c in axis))
        cap_ring = [m.vertex(m.p[index], tuple(c * direction for c in axis), m.uv[index]) for index in ring]
        for j in range(sides):
            k = (j + 1) % sides
            m.triangle(center, cap_ring[k], cap_ring[j]) if direction < 0 else m.triangle(center, cap_ring[j], cap_ring[k])
    return m


def sphere(center, radius, slices=12, stacks=8):
    m = Mesh.empty()
    rows = []
    for i in range(stacks + 1):
        phi = math.pi * i / stacks
        row = []
        for j in range(slices):
            theta = 2 * math.pi * j / slices
            normal = (math.sin(phi) * math.cos(theta), math.sin(phi) * math.sin(theta), math.cos(phi))
            row.append(m.vertex(tuple(center[k] + radius * normal[k] for k in range(3)), normal, (j / slices, i / stacks)))
        rows.append(row)
    for i in range(stacks):
        for j in range(slices):
            k = (j + 1) % slices
            m.quad(rows[i][j], rows[i + 1][j], rows[i + 1][k], rows[i][k])
    return m


def tube(points, radius, sides=8, string_uv=False):
    m = Mesh.empty()
    rows = []
    for i, point in enumerate(points):
        tangent = normalize(tuple(points[min(i + 1, len(points) - 1)][k] - points[max(i - 1, 0)][k] for k in range(3)))
        ref = (0, 0, 1) if abs(tangent[2]) < 0.9 else (0, 1, 0)
        u = normalize(cross(tangent, ref))
        v = normalize(cross(tangent, u))
        row = []
        for j in range(sides):
            angle = 2 * math.pi * j / sides
            normal = normalize(tuple(u[k] * math.cos(angle) + v[k] * math.sin(angle) for k in range(3)))
            uv = (point[0], j / sides) if string_uv else (i / (len(points) - 1), j / sides)
            row.append(m.vertex(tuple(point[k] + radius * normal[k] for k in range(3)), normal, uv))
        rows.append(row)
    for i in range(len(rows) - 1):
        for j in range(sides):
            k = (j + 1) % sides
            m.quad(rows[i][j], rows[i][k], rows[i + 1][k], rows[i + 1][j])
    return m


def extruded_shape(outline, z_bottom, z_top, *, radial=0, uv_scale=None, dome=0.001):
    outline = list(outline)
    area = sum(outline[i][0] * outline[(i + 1) % len(outline)][1] -
               outline[(i + 1) % len(outline)][0] * outline[i][1] for i in range(len(outline)))
    if area < 0:
        outline.reverse()
    m = Mesh.empty()
    center = (sum(p[0] for p in outline) / len(outline), sum(p[1] for p in outline) / len(outline))
    rings = []
    layers = max(1, radial)
    for side, zbase in ((1, z_top), (-1, z_bottom)):
        side_rings = []
        for ring in range(1, layers + 1):
            t = ring / layers
            row = []
            for x, y in outline:
                px, py = center[0] + (x - center[0]) * t, center[1] + (y - center[1]) * t
                z = zbase + (dome * (1 - t) ** 2 if side > 0 else -dome * 0.5 * (1 - t) ** 2)
                uv = ((px + 0.4) / (uv_scale or 0.9), (py + 0.2) / 0.4)
                row.append(m.vertex((px, py, z), (0, 0, side), uv))
            side_rings.append(row)
        c = m.vertex((center[0], center[1], zbase + (dome if side > 0 else -dome * 0.5)), (0, 0, side), (0.5, 0.5))
        for j in range(len(outline)):
            k = (j + 1) % len(outline)
            if side > 0:
                m.triangle(c, side_rings[0][j], side_rings[0][k])
            else:
                m.triangle(c, side_rings[0][k], side_rings[0][j])
            for ring in range(len(side_rings) - 1):
                a, b = side_rings[ring][j], side_rings[ring][k]
                d, e = side_rings[ring + 1][j], side_rings[ring + 1][k]
                m.quad(a, d, e, b) if side > 0 else m.quad(b, e, d, a)
    top, bottom = [], []
    for x, y in outline:
        uv = ((x + 0.4) / (uv_scale or 0.9), (y + 0.2) / 0.4)
        top.append(m.vertex((x, y, z_top), (0, 0, 1), uv))
        bottom.append(m.vertex((x, y, z_bottom), (0, 0, -1), uv))
    for j in range(len(outline)):
        k = (j + 1) % len(outline)
        m.quad(top[j], bottom[j], bottom[k], top[k])
    return m


def layered_body(outline, z_bottom, z_top, radial):
    m = Mesh.empty()
    min_x, max_x = min(p[0] for p in outline), max(p[0] for p in outline)
    min_y, max_y = min(p[1] for p in outline), max(p[1] for p in outline)
    cx, cy = (min_x + max_x) / 2, (min_y + max_y) / 2
    uv = lambda x, y: ((x - min_x) / (max_x - min_x), (y - min_y) / (max_y - min_y))
    n = len(outline)
    # Dense radial surfaces provide a smooth, curved top and bottom without a fused prop mesh.
    for sign, edge_z in ((1, z_top), (-1, z_bottom)):
        rows = []
        rings = radial
        for ri in range(rings):
            t = (ri + 1) / rings
            row = []
            for x, y in outline:
                px, py = cx + (x - cx) * t, cy + (y - cy) * t
                bulge = BODY_DOME * (1 - t) ** 2 * sign
                z = edge_z + bulge
                normal = normalize((2 * BODY_DOME * (px - cx) / 0.32, 2 * BODY_DOME * (py - cy) / 0.32, sign))
                row.append(m.vertex((px, py, z), normal, uv(px, py)))
            rows.append(row)
        center = m.vertex((cx, cy, edge_z + sign * BODY_DOME), (0, 0, sign), (0.5, 0.5))
        for j in range(n):
            k = (j + 1) % n
            if sign > 0:
                m.triangle(center, rows[0][j], rows[0][k])
            else:
                m.triangle(center, rows[0][k], rows[0][j])
        for ri in range(rings - 1):
            for j in range(n):
                k = (j + 1) % n
                a, b = rows[ri][j], rows[ri][k]
                c, d = rows[ri + 1][j], rows[ri + 1][k]
                m.quad(a, c, d, b) if sign > 0 else m.quad(a, b, d, c)
    # Rounded body side and a narrow rolled perimeter.
    top, bottom = [], []
    for x, y in outline:
        before, after = outline[(len(top) - 1) % n], outline[(len(top) + 1) % n]
        normal = normalize((after[1] - before[1], before[0] - after[0], 0))
        top.append(m.vertex((x, y, z_top), normal, uv(x, y)))
        bottom.append(m.vertex((x, y, z_bottom), normal, uv(x, y)))
    for j in range(n):
        k = (j + 1) % n
        m.quad(top[j], bottom[j], bottom[k], top[k])
    return m


def fret_x(fret, scale, nut_x):
    return nut_x - scale * (1 - 2 ** (-fret / 12))


def string_y(index, count, bridge_spacing, nut_spacing):
    t = index / (count - 1)
    return bridge_spacing * (0.5 - t) * 2 * (1 - 0.28 * t) + nut_spacing * (0.5 - t) * 2 * (0.28 * t)


def tuner_position(index, kind):
    if kind == "guitar":
        return 0.018 + index * 0.021, 0.014 + index * 0.004
    side = 1 if index < 2 else -1
    return 0.025 + (index % 2) * 0.055, side * (0.018 + (index % 2) * 0.01)


def png_chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)


def png_image(width, height, pixel):
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(pixel(x, y, width, height))
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + png_chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + png_chunk(b"IEND", b"")


def textures(kind):
    size = 2048
    def sunburst(x, y, w, h):
        u, v = x / (w - 1), y / (h - 1)
        warp = 0.002 * math.sin(v * 29 + math.sin(u * 8 + v * 2) * 1.1)
        warp += 0.001 * math.sin(v * 83 + math.sin(u * 17) * 1.4)
        radius = math.sqrt(((u - 0.5) * 1.65) ** 2 + ((v - 0.5) * 1.45) ** 2) + warp
        inner = max(0, min(1, (0.72 - radius) / 0.24))
        mid = max(0, min(1, (1.0 - radius) / 0.22))
        grain = 0.993 + 0.010 * math.sin(v * 180 + math.sin(u * 11 + v * 3) * 2.2)
        grain += 0.003 * math.sin(v * 520 + math.sin(u * 23) * 1.5)
        dark, red, amber = (18, 12, 10), (112, 29, 21), (224, 157, 76)
        mix = lambda a, b, t: tuple(round((a[i] + (b[i] - a[i]) * t) * grain) for i in range(3))
        col = mix(dark, red, mid)
        col = mix(col, amber, inner)
        return (*col, 255)
    def maple(x, y, w, h):
        u, v = x / (w - 1), y / (h - 1)
        grain = 0.995 + 0.008 * math.sin(v * 151 + math.sin(u * 8 + v * 2) * 2.2)
        grain += 0.002 * math.sin(v * 323 + math.sin(u * 17) * 1.5)
        return (round(211 * grain), round(163 * grain), round(105 * grain), 255)
    def fretboard(x, y, w, h):
        u, v = x / (w - 1), y / (h - 1)
        grain = 0.97 + 0.02 * math.sin(v * 167 + math.sin(u * 9 + v * 2) * 2.1)
        grain += 0.006 * math.sin(v * 314 + math.sin(u * 15) * 1.3)
        return (round(69 * grain), round(38 * grain), round(26 * grain), 255)
    bases = [png_image(size, size, sunburst), png_image(size, size, maple), png_image(size, size, fretboard)]
    def flat_normal(_x, _y, _w, _h): return (128, 128, 255, 255)
    normals = png_image(64, 64, flat_normal)
    # ORM channels follow glTF's R=occlusion, G=roughness, B=metalness packing.
    orm = png_image(64, 64, lambda _x, _y, _w, _h: (255, 255, 255, 255))
    return bases, normals, orm


class GltfBuilder:
    def __init__(self, kind, cfg):
        self.kind, self.cfg = kind, cfg
        self.nodes, self.meshes, self.materials, self.accessors, self.views = [], [], [], [], []
        self.binary = bytearray()
        self.material_ids = {}
        self.images = []
        self.textures = []
        self.extensions_used = ["KHR_materials_variants", "KHR_materials_clearcoat", "MSFT_lod"]
        self.roots = []
        self.texture_data = textures(kind)

    def node(self, name, parent=None, translation=(0, 0, 0), extras=None):
        idx = len(self.nodes)
        self.nodes.append({"name": name, "translation": list(translation), "children": [], **({"extras": extras} if extras else {})})
        if parent is None:
            self.roots.append(idx)
        else:
            self.nodes[parent]["children"].append(idx)
        return idx

    def _bytes(self, data, alignment=4):
        while len(self.binary) % alignment:
            self.binary.append(0)
        offset = len(self.binary)
        self.binary.extend(data)
        return offset, len(data)

    def _view(self, data, target):
        offset, length = self._bytes(data)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": length}
        if target:
            view["target"] = target
        self.views.append(view)
        return len(self.views) - 1

    def _accessor(self, data, component, kind, count, target=None, bounds=None):
        view = self._view(data, target)
        accessor = {"bufferView": view, "componentType": component, "count": count, "type": kind}
        if bounds:
            accessor.update(bounds)
        self.accessors.append(accessor)
        return len(self.accessors) - 1

    def image(self, data, name):
        view = self._view(data, None)
        self.images.append({"bufferView": view, "mimeType": "image/png", "name": name})
        self.textures.append({"sampler": 0, "source": len(self.images) - 1})
        return len(self.textures) - 1

    def add_textures(self):
        bases, normal, orm = self.texture_data
        base_ids = [self.image(data, f"{self.kind}-{name}") for data, name in zip(bases, ("sunburst-or-maple", "maple", "dark-wood"))]
        normal_id = self.image(normal, "fine-wood-normal")
        orm_id = self.image(orm, "PBR-occlusion-roughness-metalness")
        self.texture_ids = (base_ids, normal_id, orm_id)

    def material(self, base_name, color, rough, metal=0, texture=None, emissive=(0, 0, 0), clearcoat=0):
        key = (base_name, color, rough, metal, texture, emissive, clearcoat)
        if key in self.material_ids:
            return self.material_ids[key]
        base_ids, normal, orm = self.texture_ids
        def make(style):
            tint = VARIANT_TINTS[style]
            base = [min(1, color[i] * tint[i]) for i in range(3)] + [1]
            material = {
                "name": base_name if style == "Realistic" else f"{base_name}_{style}",
                "pbrMetallicRoughness": {"baseColorFactor": base, "metallicFactor": metal, "roughnessFactor": rough,
                    "metallicRoughnessTexture": {"index": orm}},
                "normalTexture": {"index": normal, "scale": 0.22},
                "occlusionTexture": {"index": orm, "strength": 0.75},
                "emissiveFactor": [min(1, emissive[i] * (1.0 if style != "NeonRhythm" else 2.4)) for i in range(3)],
            }
            if texture is not None:
                material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": base_ids[texture]}
            if clearcoat:
                material["extensions"] = {"KHR_materials_clearcoat": {"clearcoatFactor": clearcoat, "clearcoatRoughnessFactor": 0.19}}
            self.materials.append(material)
            return len(self.materials) - 1
        ids = [make(style) for style in STYLES]
        self.material_ids[key] = ids
        return ids

    def add_mesh(self, parent, name, mesh, materials, translation=(0, 0, 0), extras=None, lod_nodes=None, origin=None):
        if not mesh.p or not mesh.tri:
            return None
        tx, ty, tz = origin if origin is not None else translation
        local = [(x - tx, y - ty, z - tz) for x, y, z in mesh.p]
        flat_p = [x for point in local for x in point]
        flat_n = [x for point in mesh.n for x in point]
        flat_uv = [x for point in mesh.uv for x in point]
        flat_idx = [i for tri in mesh.tri for i in tri]
        pbytes = struct.pack(f"<{len(flat_p)}f", *flat_p)
        nbytes = struct.pack(f"<{len(flat_n)}f", *flat_n)
        uvbytes = struct.pack(f"<{len(flat_uv)}f", *flat_uv)
        pacc = self._accessor(pbytes, 5126, "VEC3", len(mesh.p), 34962, {"min": [min(p[i] for p in local) for i in range(3)], "max": [max(p[i] for p in local) for i in range(3)]})
        nacc = self._accessor(nbytes, 5126, "VEC3", len(mesh.n), 34962)
        uvacc = self._accessor(uvbytes, 5126, "VEC2", len(mesh.uv), 34962)
        component = 5123 if len(mesh.p) < 65536 else 5125
        fmt = "H" if component == 5123 else "I"
        ibytes = struct.pack(f"<{len(flat_idx)}{fmt}", *flat_idx)
        iacc = self._accessor(ibytes, component, "SCALAR", len(flat_idx), 34963)
        # Materials are a variant per renderer style; the geometry remains unchanged.
        if isinstance(materials, int):
            style_materials = [materials] * len(STYLES)
        else:
            style_materials = materials
        primitive = {
            "attributes": {"POSITION": pacc, "NORMAL": nacc, "TEXCOORD_0": uvacc},
            "indices": iacc, "material": style_materials[0],
            "extensions": {"KHR_materials_variants": {"mappings": [
                {"material": style_materials[i], "variants": [i]} for i in range(len(STYLES))
            ]}},
        }
        mesh_idx = len(self.meshes)
        self.meshes.append({"name": name, "primitives": [primitive]})
        node_idx = self.node(name, parent, translation, extras)
        self.nodes[node_idx]["mesh"] = mesh_idx
        if lod_nodes:
            self.nodes[node_idx]["extensions"] = {"MSFT_lod": {"ids": lod_nodes}}
        return node_idx

    def group(self, parent, name, translation=(0, 0, 0), extras=None):
        return self.node(name, parent, translation, extras)

    def add_position_nodes(self, parent, kind):
        cfg = self.cfg
        scale, nut_x, frets = cfg["scale"], cfg["scale"], cfg["frets"]
        low, high = cfg["lowY"], cfg["highY"]
        for phys, string in enumerate(cfg["strings"], 1):
            for fret in range(frets + 1):
                distance = scale * (1 - 2 ** (-fret / 12))
                coord = scale if fret == 0 else (fret_x(fret - 1, scale, nut_x) + fret_x(fret, scale, nut_x)) / 2
                x = coord
                y = low + (high - low) * (phys - 1) / (len(cfg["strings"]) - 1)
                midi = string["midi"] + fret
                pitch = PITCH_NAMES[midi % 12]
                container = self.position_root
                self.node(f"Position_S{phys}_F{fret}", container, (x - cfg["joint"], y, cfg["positionZ"]), {
                    "stringObject": f"String_{phys}_{string['name'].replace(' ', '')}",
                    "conventionalStringNumber": string["conventional"],
                    "fret": fret,
                    "pitchName": f"{pitch}{midi // 12 - 1}",
                    "midiNote": midi,
                    "pitchClass": pitch,
                    "octave": midi // 12 - 1,
                    "fretboardCoordinate": coord,
                    "fretDistanceFromNut": distance,
                    "kind": kind,
                })

    def build(self):
        self.add_textures()
        kind, cfg = self.kind, self.cfg
        root = self.group(None, "ElectricGuitar" if kind == "guitar" else "ElectricBass", extras={
            "assetContract": "fretted-instrument-v1", "instrument": kind, "units": "meters",
            "scaleLength": cfg["scale"], "playableFrets": cfg["frets"], "strings": cfg["strings"],
            "overallLength": cfg["overall"], "bodyWidth": cfg["bodyWidth"], "bodyThickness": cfg["thickness"],
            "rightHanded": True, "stylePresets": STYLES,
            "feedbackStates": ["base", "upcoming", "current-target", "correctly-played", "incorrectly-played", "held",
                "muted-string", "open-string", "scale-membership", "chord-membership", "root-note", "suggested-finger", "selected-position"],
            "feedbackPriority": ["incorrectly-played", "current-played", "current-target", "upcoming", "chord-or-scale", "fingering", "base"],
            "performance": {"lod0TrianglesTarget": [80000, 160000], "lod1TrianglesTarget": [35000, 80000], "lod2TrianglesTarget": [12000, 30000]},
        })
        body = self.group(root, "Body", extras={"pivot": "body-center-of-mass"})
        neck = self.group(root, "Neck", (cfg["joint"], 0, 0), {"pivot": "neck-body-joint", "scaleLength": cfg["scale"]})
        head = self.group(root, "Headstock", (cfg["nutX"], 0, 0), {"pivot": "nut"})
        pickups = self.group(root, "Pickups")
        bridge = self.group(root, "Bridge", extras={"pivot": "fulcrum" if kind == "guitar" else "bridge-base"})
        controls = self.group(root, "Controls")
        hardware = self.group(root, "Hardware")
        strings_group = self.group(root, "Strings")
        self.position_root = self.group(neck, "FretboardPositions")

        mat_body = self.material("MAT_Body_Sunburst", (1, 1, 1), 0.24, 0, 0, clearcoat=0.72)
        mat_maple = self.material("MAT_Neck_Maple", (1, 1, 1), 0.38, 0, 1)
        mat_fretboard = self.material("MAT_Fretboard_DarkWood", (1, 1, 1), 0.48, 0, 2)
        mat_cream = self.material("MAT_Pickguard_Cream", (0.96, 0.94, 0.84), 0.42)
        mat_plastic = self.material("MAT_ControlPlastic_Cream", (0.94, 0.91, 0.81), 0.32)
        mat_metal = self.material("MAT_Metal_Chrome", (0.72, 0.78, 0.85), 0.27, 0.85)
        mat_brush = self.material("MAT_Metal_Brushed", (0.52, 0.57, 0.61), 0.38, 0.8)
        mat_fret = self.material("MAT_FretMetal", (0.78, 0.82, 0.88), 0.22, 0.78)
        mat_steel = self.material("MAT_String_Steel", (0.78, 0.82, 0.86), 0.24, 0.82)
        mat_wound = self.material("MAT_String_NickelWound", (0.63, 0.67, 0.71), 0.37, 0.72)
        mat_inlay = self.material("MAT_Inlay", (0.85, 0.86, 0.79), 0.36, 0.1)
        mat_back = self.material("MAT_BackPlate_Cream", (0.79, 0.74, 0.63), 0.48)
        mat_jack = self.material("MAT_OutputJackMetal", (0.52, 0.57, 0.62), 0.26, 0.85)
        mat_coil = self.material("MAT_Pickup_Cream" if kind == "guitar" else "MAT_Pickup_Black",
            (0.94, 0.91, 0.82) if kind == "guitar" else (0.045, 0.045, 0.045), 0.34)
        mat_bobbin = self.material("MAT_Pickup_Bobbin", (0.12, 0.105, 0.09), 0.58)

        # The body uses a closed sculpted outline and a rolled, subtly domed top.
        if kind == "guitar":
            control = [(0.17, 0.031), (0.22, 0.051), (0.28, 0.10), (0.275, 0.128),
                (0.24, 0.14), (0.175, 0.116), (0.105, 0.085), (0.035, 0.135),
                (-0.04, 0.16), (-0.12, 0.136), (-0.18, 0.084), (-0.195, 0.015),
                (-0.177, -0.075), (-0.118, -0.133), (-0.04, -0.16), (0.035, -0.141),
                (0.11, -0.086), (0.18, -0.107), (0.242, -0.118), (0.27, -0.095),
                (0.267, -0.072), (0.222, -0.041), (0.17, -0.027)]
        else:
            control = [(0.20, 0.033), (0.25, 0.058), (0.30, 0.11), (0.285, 0.139),
                (0.24, 0.15), (0.17, 0.118), (0.10, 0.093), (0.025, 0.142),
                (-0.055, 0.165), (-0.135, 0.138), (-0.185, 0.072), (-0.195, 0.004),
                (-0.171, -0.087), (-0.105, -0.149), (-0.025, -0.165), (0.054, -0.135),
                (0.127, -0.094), (0.207, -0.116), (0.27, -0.117), (0.287, -0.083),
                (0.251, -0.049), (0.20, -0.027)]
        outline = catmull(control, 8)
        area = sum(outline[i][0] * outline[(i + 1) % len(outline)][1] -
                   outline[(i + 1) % len(outline)][0] * outline[i][1] for i in range(len(outline)))
        if area < 0:
            outline.reverse()
        body_edge = cfg["thickness"] / 2 - BODY_DOME
        body_mesh = layered_body(outline, -body_edge, body_edge, 150)
        body_node = self.add_mesh(body, "Body_Mesh", body_mesh, mat_body, extras={"bevelled": True, "triangleCount": len(body_mesh.tri)})
        pick = catmull([(0.18, 0.031), (0.23, 0.057), (0.25, 0.076), (0.221, 0.089),
            (0.145, 0.074), (0.075, 0.079), (0, 0.071), (-0.037, 0.032),
            (-0.025, -0.02), (0.035, -0.071), (0.11, -0.114), (0.175, -0.108),
            (0.20, -0.074), (0.17, -0.032)], 8)
        self.add_mesh(body, "Pickguard", extruded_shape(pick, cfg["thickness"] / 2 - 0.0035,
            cfg["thickness"] / 2 + 0.0003, radial=1, dome=0.00035), mat_cream)
        self.add_mesh(body, "RearCover_Electronics", box((0.03, -0.038, -cfg["thickness"] / 2 - 0.002), (0.15, 0.085, 0.002)), mat_back)
        if kind == "guitar":
            self.add_mesh(body, "RearCover_Tremolo", box((-0.025, 0, -cfg["thickness"] / 2 - 0.002), (0.12, 0.07, 0.002)), mat_back)
        jack_x, jack_y, jack_z = -0.082, -0.095, cfg["thickness"] / 2 + 0.002
        jack_outline = [(jack_x + 0.024 * math.cos(a), jack_y + 0.012 * math.sin(a))
            for a in (i * math.tau / 24 for i in range(24))]
        self.add_mesh(body, "OutputJack_Plate", extruded_shape(jack_outline, jack_z, jack_z + 0.002), mat_jack)
        self.add_mesh(body, "OutputJack", cylinder((jack_x + 0.006, jack_y, jack_z + 0.002),
            (jack_x + 0.01, jack_y - 0.004, jack_z + 0.005), 0.005, 16), mat_bobbin)
        tail_x = min(p[0] for p in outline)
        top_strap = max((p for p in outline if p[1] > 0), key=lambda p: p[0])
        self.add_mesh(body, "StrapButton_Top", cylinder((*top_strap, 0),
            (top_strap[0] + 0.008, top_strap[1], 0), 0.004, 14), mat_metal)
        self.add_mesh(body, "StrapButton_Bottom", cylinder((tail_x + 0.002, 0, 0),
            (tail_x - 0.006, 0, 0), 0.004, 14), mat_metal)

        # Bolt-on neck, 22 guitar or 20 bass fret positions, and a separately selectable board.
        neck_start, nut_x = cfg["joint"], cfg["nutX"]
        board_width = lambda x: 0.042 + 0.020 * (nut_x - x) / cfg["scale"]
        heel_half = board_width(neck_start) / 2
        fboard_outline = [(neck_start, -heel_half), (neck_start, heel_half), (nut_x, 0.021), (nut_x, -0.021)]
        self.add_mesh(neck, "Neck_Mesh", extruded_shape(fboard_outline, 0.021, 0.043, radial=12), mat_maple,
            extras={"boltOn": True}, origin=(neck_start, 0, 0))
        heel = box((neck_start - 0.025, 0, 0.003), (0.08, 0.06, 0.036))
        self.add_mesh(neck, "Neck_Heel", heel, mat_maple, origin=(neck_start, 0, 0))
        board_outline = [(neck_start - 0.01, -heel_half), (neck_start - 0.01, heel_half), (nut_x, 0.021), (nut_x, -0.021)]
        self.add_mesh(neck, "Fretboard", extruded_shape(board_outline, 0.042, 0.048, radial=16),
            mat_fretboard, extras={"radiusMeters": 0.241}, origin=(neck_start, 0, 0))
        self.add_mesh(neck, "Nut", box((nut_x, 0, 0.050), (0.006, 0.044, 0.006)), mat_cream, origin=(neck_start, 0, 0))
        frets_root = self.group(neck, "Frets")
        for fret in range(1, cfg["frets"] + 1):
            x = fret_x(fret, cfg["scale"], nut_x)
            width = board_width(x)
            bar = cylinder((x, -width / 2, 0.048), (x, width / 2, 0.048), 0.00075, 8)
            self.add_mesh(frets_root, f"Fret_{fret:02d}", bar, mat_fret, origin=(neck_start, 0, 0),
                extras={"fret": fret, "distanceFromNut": cfg["scale"] * (1 - 2 ** (-fret / 12))})
        inlays = self.group(neck, "Inlays")
        for fret in (3, 5, 7, 9, 12, 15, 17, 19, 21, 24):
            if fret >= cfg["frets"]:
                continue
            ix = (fret_x(fret - 1, cfg["scale"], nut_x) + fret_x(fret, cfg["scale"], nut_x)) / 2
            positions = (-0.01, 0.01) if fret == 12 else (0,)
            for side, y in enumerate(positions):
                self.add_mesh(inlays, f"Inlay_{fret:02d}_{'Left' if side == 0 and len(positions) > 1 else 'Right' if len(positions) > 1 else 'Center'}",
                sphere((ix, y, 0.0485), 0.004, 16, 8), mat_inlay, origin=(neck_start, 0, 0))
        side_inlays = self.group(inlays, "SideInlays")
        for fret in (3, 5, 7, 9, 12, 15, 17, 19, 21):
            if fret <= cfg["frets"]:
                ix = (fret_x(fret - 1, cfg["scale"], nut_x) + fret_x(fret, cfg["scale"], nut_x)) / 2
                self.add_mesh(side_inlays, f"SideInlay_{fret:02d}", sphere((ix, -0.0315, 0.046), 0.0018, 8, 6), mat_inlay, origin=(neck_start, 0, 0))
        self.add_position_nodes(self.position_root, kind)

        # Headstock and individual tuner pivots/posts. Six inline for guitar; 2+2 for bass.
        head_length = cfg["overall"] + tail_x - 0.006 - nut_x
        hs_outline = catmull([(-0.004, -0.021), (-0.004, 0.021), (0.026, 0.028),
            (0.10, 0.044), (0.13, 0.052), (0.145, 0.028), (0.139, -0.025),
            (0.107, -0.041), (0.075, -0.031), (0.018, -0.024)], 8)
        hs_max = max(p[0] for p in hs_outline)
        hs_local = [(x * head_length / hs_max, y) for x, y in hs_outline]
        self.add_mesh(head, "Headstock_Mesh", extruded_shape(hs_local, 0.025, 0.052, radial=8), mat_maple)
        self.add_mesh(head, "StringTree_1", cylinder((0.025, 0.014, 0.056), (0.025, -0.014, 0.056), 0.0018, 10), mat_metal)
        self.add_mesh(head, "StringTree_2", cylinder((0.045, 0.014, 0.056), (0.045, -0.014, 0.056), 0.0018, 10), mat_metal)
        tuner_root = self.group(head, "TuningMachines")
        for i, string in enumerate(cfg["strings"]):
            peg_x, peg_y = tuner_position(i, kind)
            node_name = f"Tuner_{i + 1}_{string['name'].replace(' ', '')}"
            pivot = self.group(tuner_root, node_name, (peg_x, peg_y, 0.052), {
                "stringNumber": i + 1, "conventionalStringNumber": string["conventional"],
                "rotationPivot": [0, 0, 1], "stringObject": f"String_{i + 1}_{string['name'].replace(' ', '')}",
            })
            self.add_mesh(pivot, f"Tuner_{i + 1}_Post", cylinder((0, 0, 0), (0, 0, 0.009), 0.003, 10), mat_metal)
            self.add_mesh(pivot, f"Tuner_{i + 1}_Button",
                box((0, math.copysign(0.014, peg_y), 0.004), (0.01, 0.02, 0.004), bevel=0.0015), mat_metal)
            self.add_mesh(pivot, f"Tuner_{i + 1}_Housing", box((0, 0, -0.002), (0.016, 0.014, 0.004)), mat_brush)

        # Three single-coil guitar pickups or the bass's two split/single-coil pickups.
        positions = [(0.14, "Neck"), (0.09, "Middle"), (0.037, "Bridge")] if kind == "guitar" else [(0.14, "Neck"), (0.05, "Bridge")]
        for px, label in positions:
            pickup_width = 0.081 if kind == "guitar" else 0.078
            housing = box((px, 0, 0.0285), (0.018, pickup_width, 0.011), bevel=0.003)
            self.add_mesh(pickups, f"Pickup_{label}", housing, mat_bobbin,
                extras={"pickupType": "split-coil" if kind == "bass" and label == "Neck" else "single-coil"})
            if kind == "bass" and label == "Neck":
                # Stagger the two P-style bobbins; each covers a pair of adjacent strings.
                for half, (cx, indices) in enumerate(((px + 0.008, (0, 1)), (px - 0.008, (2, 3))), 1):
                    half_y = sum(string_y(i, len(cfg["strings"]), cfg["bridgeSpacing"], cfg["nutSpacing"]) for i in indices) / 2
                    self.add_mesh(pickups, f"Pickup_{label}_Half{half}",
                        box((cx, half_y, 0.0365), (0.027, 0.027, 0.006), bevel=0.002), mat_coil)
                    for i in indices:
                        string = cfg["strings"][i]
                        y = string_y(i, len(cfg["strings"]), cfg["bridgeSpacing"], cfg["nutSpacing"])
                        self.add_mesh(pickups, f"Pole_{label}_Half{half}_S{i + 1}",
                            cylinder((cx, y, 0.0395), (cx, y, 0.042), 0.0022, 10), mat_metal)
            else:
                self.add_mesh(pickups, f"Pickup_{label}_Cover",
                    box((px, 0, 0.035), (0.015, pickup_width * 0.92, 0.003), bevel=0.001), mat_coil)
                for i, string in enumerate(cfg["strings"]):
                    y = string_y(i, len(cfg["strings"]), cfg["bridgeSpacing"], cfg["nutSpacing"])
                    self.add_mesh(pickups, f"Pole_{label}_S{i + 1}",
                        cylinder((px, y, 0.0365), (px, y, 0.04), 0.0017, 10), mat_metal)

        # Bridge saddle pivots and distinct string contact points.
        base = box((-0.004, 0, 0.031), (0.022, cfg["bridgeSpacing"] * 2 + 0.018, 0.018))
        self.add_mesh(bridge, "Bridge_Base", base, mat_brush)
        if kind == "guitar":
            for i, string in enumerate(cfg["strings"]):
                y = string_y(i, len(cfg["strings"]), cfg["bridgeSpacing"], cfg["nutSpacing"])
                sx = -0.006 + i * 0.0022
                self.add_mesh(bridge, f"Saddle_{i + 1}_{string['name'].replace(' ', '')}",
                    box((sx, y, 0.045), (0.009, 0.009, 0.009)), mat_metal,
                    translation=(sx, y, 0.045), extras={"stringNumber": i + 1, "contactPoint": [sx, y, 0.049]})
            self.add_mesh(bridge, "TremoloBlock", box((-0.01, 0, 0.019), (0.025, 0.07, 0.015)), mat_brush)
            arm_pivot = self.group(bridge, "TremoloArm", (-0.006, -0.035, 0.048), {"pivot": "bridge-socket", "removable": True})
            self.add_mesh(arm_pivot, "TremoloArm_Shaft", tube([(0, 0, 0), (-0.028, -0.025, -0.01), (-0.052, -0.04, -0.011)], 0.0016, 10), mat_metal)
            self.add_mesh(arm_pivot, "TremoloArm_Tip", sphere((-0.052, -0.04, -0.011), 0.004, 12, 8), mat_plastic)
        else:
            for i, string in enumerate(cfg["strings"]):
                y = string_y(i, len(cfg["strings"]), cfg["bridgeSpacing"], cfg["nutSpacing"])
                self.add_mesh(bridge, f"Saddle_{i + 1}_{string['name'].replace(' ', '')}",
                    box((0, y, 0.045), (0.014, 0.012, 0.009)), mat_metal,
                    translation=(0, y, 0.045), extras={"stringNumber": i + 1, "contactPoint": [0, y, 0.049]})

        control_positions = [("Knob_Volume", (0.145, -0.043)), ("Knob_Tone1", (0.115, -0.075)),
            ("Knob_Tone2", (0.08, -0.095))]
        for name, point in control_positions:
            pivot = self.group(controls, name, (point[0], point[1], cfg["thickness"] / 2), {"pivot": "vertical-axis"})
            self.add_mesh(pivot, f"{name}_Seat", cylinder((0, 0, 0.0003), (0, 0, 0.0012), 0.0127, 24), mat_bobbin)
            self.add_mesh(pivot, f"{name}_Base", cylinder((0, 0, 0), (0, 0, 0.01), 0.012, 24), mat_plastic)
            self.add_mesh(pivot, f"{name}_Cap", cylinder((0, 0, 0.01), (0, 0, 0.014), 0.009, 24), mat_cream)
        if kind == "guitar":
            switch = self.group(controls, "Switch_5Way", (0.175, -0.078, cfg["thickness"] / 2 + 0.001), {"pivot": "selector-axis", "positions": 5})
            self.add_mesh(switch, "Switch_Lever", tube([(0, 0, 0), (-0.02, 0.01, 0.018)], 0.0024, 10), mat_metal)

        # Neck plate, screws, pickguard and pickup screws remain independent selectable objects.
        self.add_mesh(hardware, "NeckPlate", box((cfg["joint"] - 0.02, 0, -0.024), (0.05, 0.074, 0.006)), mat_brush)
        for i, (x, y) in enumerate(((0.22, 0.066), (0.19, -0.09), (0.0, 0.066), (0.03, -0.06)), 1):
            self.add_mesh(hardware, f"PickguardScrew_{i}", cylinder((x, y, 0.021), (x, y, 0.024), 0.0018, 8), mat_metal)
        for i, y in enumerate((-0.027, 0.027), 1):
            self.add_mesh(hardware, f"NeckScrew_{i}", cylinder((cfg["joint"], y, -0.027), (cfg["joint"], y, -0.023), 0.0025, 8), mat_metal)
        for i in range(1, 7):
            self.add_mesh(hardware, f"BridgeScrew_{i}", cylinder((-0.007, -0.025 + i * 0.01, 0.036), (-0.007, -0.025 + i * 0.01, 0.041), 0.0015, 8), mat_metal)

        # Each string is an independent swept mesh, with pinned endpoints and a physical deformation descriptor.
        for i, string in enumerate(cfg["strings"]):
            yb = string_y(i, len(cfg["strings"]), cfg["bridgeSpacing"], cfg["nutSpacing"])
            yn = cfg["lowY"] + (cfg["highY"] - cfg["lowY"]) * i / (len(cfg["strings"]) - 1)
            peg_x, peg_y = tuner_position(i, kind)
            points = []
            for segment in range(24):
                t = segment / 23
                x = cfg["nutX"] + peg_x * (1 - t)
                y = peg_y + (yn - peg_y) * t
                points.append((x, y, 0.056 - 0.004 * t))
            for segment in range(1, 64):
                t = segment / 64
                x = cfg["nutX"] * (1 - t)
                y = yn + (yb - yn) * t
                points.append((x, y, 0.052 - 0.010 * t))
            points.append((0, yb, 0.042))
            gauge = string["gauge"]
            radius = gauge * 0.0254 / 2
            mesh = tube(points, radius, 8, string_uv=True)
            obj = f"String_{i + 1}_{string['name'].replace(' ', '')}"
            self.add_mesh(strings_group, obj, mesh, mat_wound if i < len(cfg["strings"]) - 3 else mat_steel,
                extras={"stringNumber": i + 1, "conventionalStringNumber": string["conventional"], "openMidi": string["midi"],
                    "openPitch": string["pitch"], "gaugeInches": gauge, "deformable": True,
                    "vibration": {"model": "pinned-sine", "axis": [0, 1, 0], "start": f"Position_S{i + 1}_F0",
                        "end": f"Saddle_{i + 1}_{string['name'].replace(' ', '')}", "amplitudeMeters": 0.002,
                        "maximumAtActiveLengthFraction": 0.5, "envelope": "zero-at-selected-fret-and-bridge",
                        "runtimeAttribute": "position.x"}})

        # Named, inexpensive collider nodes are metadata only, not hidden high-poly copies.
        collisions = self.group(root, "CollisionShapes")
        for name, center, size in (
            ("COL_Body", [0.055, 0, 0], [0.49, cfg["bodyWidth"], cfg["thickness"]]),
            ("COL_Neck", [(cfg["joint"] + cfg["nutX"]) / 2, 0, 0.04], [cfg["nutX"] - cfg["joint"], 0.064, 0.03]),
            ("COL_Fretboard", [(cfg["joint"] + cfg["nutX"]) / 2, 0, 0.048], [cfg["nutX"] - cfg["joint"], 0.056, 0.014]),
            ("COL_Headstock", [cfg["nutX"] + head_length / 2, 0, 0.04], [head_length, 0.11, 0.035]),
            ("COL_Pickguard", [0.11, -0.01, 0.028], [0.325, 0.22, 0.006]),
            ("COL_Pickup_Neck", [positions[0][0], 0, 0.04], [0.03, 0.09, 0.02]),
            ("COL_Pickup_Bridge", [positions[-1][0], 0, 0.04], [0.03, 0.09, 0.02]),
            ("COL_Bridge", [0, 0, 0.035], [0.04, 0.1, 0.02]),
            ("COL_OutputJack", [jack_x, jack_y, jack_z], [0.05, 0.03, 0.012]),
        ):
            self.node(name, collisions, tuple(center), {"shape": "capsule", "size": size, "selectable": True})
        for name, (x, y) in control_positions:
            self.node(f"COL_{name}", collisions, (x, y, 0.04),
                {"shape": "capsule", "size": [0.03, 0.03, 0.025], "selectable": True})
        if kind == "guitar":
            for name, center, size in (
                ("COL_Pickup_Middle", [0.09, 0, 0.04], [0.03, 0.09, 0.02]),
                ("COL_TremoloArm", [-0.04, -0.07, 0.045], [0.1, 0.06, 0.015]),
                ("COL_Switch_5Way", [0.175, -0.078, 0.04], [0.035, 0.02, 0.02]),
            ):
                self.node(name, collisions, tuple(center), {"shape": "capsule", "size": size, "selectable": True})
        for i, string in enumerate(cfg["strings"]):
            y = string_y(i, len(cfg["strings"]), cfg["bridgeSpacing"], cfg["nutSpacing"])
            self.node(f"COL_String_{i + 1}_{string['name'].replace(' ', '')}", collisions, (cfg["scale"] / 2, y, 0.052),
                {"shape": "capsule", "radius": 0.002, "length": cfg["scale"], "stringNumber": i + 1, "selectable": True})

        # The body is the main LOD cost; the two lower levels preserve strings and position locators.
        # Additional mesh objects are kept separate, while LOD nodes are referenced by MSFT_lod.
        self.make_lods(root, outline, mat_body, kind, body_node)
        return root

    def make_lods(self, root, outline, body_material, kind, body_node):
        # The display loader picks LOD0 for the learning close-up and LOD1/2 for the whole-instrument view on small screens.
        root_extras = self.nodes[root].setdefault("extras", {})
        root_extras["lodNames"] = ["LOD0", "LOD1", "LOD2"]
        # Body-only LOD resources are standards-compatible references and do not alter the canonical scene hierarchy.
        lod_ids = []
        for level, rings in ((1, 70), (2, 14)):
            lod_body = self.group(None, f"LOD{level}_Body_Mesh", extras={"lodLevel": level, "canonicalName": "Body_Mesh"})
            body_edge = self.cfg["thickness"] / 2 - BODY_DOME
            mesh = layered_body(outline, -body_edge, body_edge, rings)
            mesh_node = self.add_mesh(lod_body, f"Body_Mesh_LOD{level}", mesh, body_material,
                extras={"lodLevel": level, "canonicalName": "Body_Mesh", "triangleCount": len(mesh.tri)})
            lod_ids.append(mesh_node)
        self.nodes[body_node]["extensions"] = {"MSFT_lod": {"ids": lod_ids}}

    def build_bytes(self):
        root = self.build()
        # The mesh/material variants are available without any camera, light, floor, or external reference asset.
        while len(self.binary) % 4:
            self.binary.append(0)
        json_obj = {
            "asset": {"version": "2.0", "generator": "Mizan fretted instrument builder"},
            "scene": 0, "scenes": [{"nodes": [root]}],
            "nodes": self.nodes, "meshes": self.meshes,
            "materials": self.materials, "accessors": self.accessors, "bufferViews": self.views,
            "buffers": [{"byteLength": len(self.binary)}],
            "images": self.images, "textures": self.textures,
            "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
            "extensionsUsed": self.extensions_used,
            "extensions": {"KHR_materials_variants": {"variants": [{"name": name} for name in STYLES]}},
        }
        json_data = json.dumps(json_obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        json_data += b" " * ((4 - len(json_data) % 4) % 4)
        binary = bytes(self.binary)
        total = 12 + 8 + len(json_data) + 8 + len(binary)
        return struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<I4s", len(json_data), b"JSON") + json_data + struct.pack("<I4s", len(binary), b"BIN\x00") + binary


CONFIGS = {
    "guitar": {"scale": 0.6477, "frets": 22, "overall": 1.0, "bodyWidth": 0.32, "thickness": 0.045,
        "nutX": 0.6477, "joint": 0.17, "bridgeSpacing": 0.027, "nutSpacing": 0.018, "lowY": 0.018, "highY": -0.018,
        "positionZ": 0.050, "strings": [
            {"name": "LowE", "pitch": "E2", "midi": 40, "conventional": 6, "gauge": 0.046},
            {"name": "A", "pitch": "A2", "midi": 45, "conventional": 5, "gauge": 0.036},
            {"name": "D", "pitch": "D3", "midi": 50, "conventional": 4, "gauge": 0.026},
            {"name": "G", "pitch": "G3", "midi": 55, "conventional": 3, "gauge": 0.017},
            {"name": "B", "pitch": "B3", "midi": 59, "conventional": 2, "gauge": 0.013},
            {"name": "HighE", "pitch": "E4", "midi": 64, "conventional": 1, "gauge": 0.010},
        ]},
    "bass": {"scale": 0.8636, "frets": 20, "overall": 1.18, "bodyWidth": 0.33, "thickness": 0.045,
        "nutX": 0.8636, "joint": 0.22, "bridgeSpacing": 0.027, "nutSpacing": 0.017, "lowY": 0.017, "highY": -0.017,
        "positionZ": 0.050, "strings": [
            {"name": "LowE", "pitch": "E1", "midi": 28, "conventional": 4, "gauge": 0.105},
            {"name": "A", "pitch": "A1", "midi": 33, "conventional": 3, "gauge": 0.085},
            {"name": "D", "pitch": "D2", "midi": 38, "conventional": 2, "gauge": 0.065},
            {"name": "G", "pitch": "G2", "midi": 43, "conventional": 1, "gauge": 0.045},
        ]},
}


def build_asset(kind):
    path = MODEL_DIR / ("ElectricGuitar.glb" if kind == "guitar" else "ElectricBass.glb")
    data = GltfBuilder(kind, CONFIGS[kind]).build_bytes()
    path.write_bytes(data)
    return path, len(data)


if __name__ == "__main__":
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    for instrument in ("guitar", "bass"):
        path, size = build_asset(instrument)
        print(f"{path.relative_to(ROOT)}: {size:,} bytes")
