import os
import re
from dataclasses import dataclass
from typing import Optional, List, Tuple

import numpy as np
from PIL import Image

import rasterio
from rasterio.windows import Window
from rasterio.transform import Affine
from pyproj import Transformer

from pystac_client import Client
import planetary_computer as pc


PC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"


@dataclass
class Point:
    name: str
    lat: float
    lon: float


POINTS: List[Point] = [
    Point("The Woodlands HS", 30.193690775992867, -95.5065837951534),
    Point("OkState Track", 36.13176223612263, -97.06600421315979),
    Point("Stillwater HS", 36.13687046693431, -97.06307135912624),
    Point("Air Academy High School", 38.9666949001817, -104.84433906504772),
    Point("Woodland Park Dirt Track", 39.00962319329717, -105.04839725395877),
    Point("Woodland Park High School", 38.995316784655074, -105.04333637617641),
    Point("Boulder High School", 40.01274199109346, -105.27591027461592),
    Point("Potts Field", 40.01037268781271, -105.2486318303362),
    Point("Hayward Field", 44.04228586715596, -123.07081363623224),
    Point("South Eugene High School", 44.03483889317019, -123.08667926902748),
    Point("Eugene Arts and Tech High School", 44.03423482920221, -123.115312462144),
    Point("Rice Field (Waco, 4 lane)", 31.48169838877525, -97.20515398521871),
    Point("Panther Stadium (Waco)", 31.480314982877267, -97.20234958297053),
    Point("Arkansas", 36.06290110824897, -94.1794136015293),
    Point("Fayetteville HS (Unfinished Track)", 36.061641713548354, -94.17264879188158),
]


def slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")


def choose_asset(item) -> Tuple[str, str]:
    """
    Return (asset_key, href). NAIP assets can vary by catalog;
    we prefer common keys, else any GeoTIFF-like asset.
    """
    preferred_keys = ["image", "visual", "analytic", "data", "cog"]
    for k in preferred_keys:
        if k in item.assets:
            return k, item.assets[k].href

    for k, a in item.assets.items():
        mt = (a.media_type or "").lower()
        if "geotiff" in mt or "image/tiff" in mt:
            return k, a.href

    # fallback
    k = next(iter(item.assets.keys()))
    return k, item.assets[k].href


def find_best_naip_item(lat: float, lon: float, year: Optional[int] = None):
    client = Client.open(PC_STAC)

    search = client.search(
        collections=["naip"],
        intersects={"type": "Point", "coordinates": [lon, lat]},
        max_items=50,
    )
    items = list(search.get_items())
    if not items:
        raise RuntimeError("No NAIP items found for this point.")

    # Optional year filter (NAIP is not annual everywhere, so allow fallback)
    if year is not None:
        y = str(year)
        filtered = []
        for it in items:
            dt_year = str(getattr(it.datetime, "year", ""))
            prop_year = str(it.properties.get("naip:year", ""))  # may or may not exist
            if dt_year == y or prop_year == y:
                filtered.append(it)
        if filtered:
            items = filtered

    # Most recent first
    items.sort(key=lambda it: it.datetime or "", reverse=True)
    return items[0]


def chip_from_href(
    href: str,
    lat: float,
    lon: float,
    chip_px: int,
    out_tif: str,
    out_png: str,
):
    os.makedirs(os.path.dirname(out_tif), exist_ok=True)
    os.makedirs(os.path.dirname(out_png), exist_ok=True)

    with rasterio.open(href) as src:
        tfm = Transformer.from_crs("EPSG:4326", src.crs, always_xy=True)
        x, y = tfm.transform(lon, lat)

        row, col = src.index(x, y)
        half = chip_px // 2
        win = Window(
            col_off=col - half,
            row_off=row - half,
            width=chip_px,
            height=chip_px,
        )

        # read up to 4 bands (NAIP often RGBNIR)
        band_count = min(src.count, 4)
        arr = src.read(
            indexes=list(range(1, band_count + 1)),
            window=win,
            boundless=True,
            fill_value=0,
        )

        # Write georeferenced chip GeoTIFF
        chip_transform: Affine = src.window_transform(win)
        profile = src.profile.copy()
        profile.update(
            {
                "height": chip_px,
                "width": chip_px,
                "transform": chip_transform,
                "count": band_count,
                "compress": "deflate",
            }
        )

    with rasterio.open(out_tif, "w", **profile) as dst:
        dst.write(arr)

    # Save RGB preview PNG
    rgb = np.transpose(arr[:3], (1, 2, 0))
    if rgb.dtype != np.uint8:
        # Common case: uint16 -> uint8
        if rgb.dtype == np.uint16:
            rgb = (rgb / 256.0).clip(0, 255).astype(np.uint8)
        else:
            # generic normalize
            m = rgb.max() if rgb.max() > 0 else 1.0
            rgb = (rgb / m * 255.0).clip(0, 255).astype(np.uint8)

    Image.fromarray(rgb).save(out_png)


def main(
    out_dir: str = "naip_chips",
    chip_px: int = 1024,
    year: Optional[int] = None,
):
    for p in POINTS:
        item = find_best_naip_item(p.lat, p.lon, year=year)

        # Sign item assets for access through Planetary Computer
        item = pc.sign(item)

        asset_key, href = choose_asset(item)
        safe = slugify(p.name)

        out_tif = os.path.join(out_dir, "tif", f"{safe}.tif")
        out_png = os.path.join(out_dir, "png", f"{safe}.png")

        print(f"[{p.name}] item={item.id} date={item.datetime} asset={asset_key}")
        chip_from_href(href, p.lat, p.lon, chip_px, out_tif, out_png)

    print(f"\nDone. Wrote chips to: {out_dir}/tif and previews to: {out_dir}/png")


if __name__ == "__main__":
    main(out_dir="naip_chips", chip_px=1024, year=None)
