"""
sunback.webapp.pipeline.poster_generator
----------------------------------------
Prototype pipeline for generating printable solar imagery for a given date
and preparing it for upload to a Printful storefront.

This module:
  1. Fetches data using SunPy FIDO
  2. Processes FITS data into a high-quality PNG using any Sunback filter
  3. Uploads result to Printful via their REST API

Requires:
    - sunpy
    - numpy
    - matplotlib
    - requests
"""

import os
import io
import requests
import numpy as np
import matplotlib.pyplot as plt
from sunpy.net import Fido, attrs as a
from sunpy.map import Map
from astropy import units as u
from datetime import datetime, timedelta


# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------

PRINTFUL_API_KEY = os.getenv("PRINTFUL_API_KEY")  # store in env var!
PRINTFUL_BASE_URL = "https://api.printful.com"
OUTPUT_DIR = os.getenv("SUNBACK_OUTPUT_DIR", "./output")

# Example AIA wavelength
DEFAULT_INSTRUMENT = "AIA"
DEFAULT_WAVELENGTH = 171 * u.angstrom


# ---------------------------------------------------------------------------
# FETCHING FITS DATA
# ---------------------------------------------------------------------------

def fetch_solar_fits(date: str, instrument: str = DEFAULT_INSTRUMENT, wavelength=DEFAULT_WAVELENGTH):
    """
    Fetch FITS file from a public archive via SunPy FIDO.

    Parameters
    ----------
    date : str
        Date string (YYYY-MM-DD)
    instrument : str
        Solar instrument (e.g., "AIA")
    wavelength : astropy.units.Quantity
        Wavelength to retrieve (e.g., 211 * u.angstrom)

    Returns
    -------
    sunpy.map.Map
        Map object ready for processing.
    """

    date = datetime.strptime(date, "%Y-%m-%d")
    query = Fido.search(
        a.Time(date, date + timedelta(days=1)),
        a.Instrument(instrument),
        a.Wavelength(wavelength)
    )
    downloaded = Fido.fetch(query[0, 0])
    return Map(downloaded[0])


# ---------------------------------------------------------------------------
# IMAGE PROCESSING
# ---------------------------------------------------------------------------

def process_map_to_png(smap, filter_func=None, outname=None):
    """
    Apply filtering and save a printable PNG file.

    Parameters
    ----------
    smap : sunpy.map.Map
        The input solar map.
    filter_func : callable, optional
        Function that takes an ndarray and returns a processed ndarray.
    outname : str, optional
        Output PNG path.

    Returns
    -------
    str
        Path to the saved PNG file.
    """
    data = smap.data.astype(float)
    if filter_func is not None:
        data = filter_func(data)

    # Normalize for visualization
    norm = np.percentile(data, (0.1, 99.9))
    plt.figure(figsize=(8, 8))
    plt.imshow(data, cmap='magma', vmin=norm[0], vmax=norm[1], origin='lower')
    plt.axis('off')

    if outname is None:
        outname = os.path.join(OUTPUT_DIR, f"sun_{smap.date.strftime('%Y%m%d')}.png")
    plt.savefig(outname, dpi=300, bbox_inches='tight', pad_inches=0)
    plt.close()
    return outname


# ---------------------------------------------------------------------------
# PRINTFUL UPLOAD
# ---------------------------------------------------------------------------

def upload_to_printful(image_path: str, title: str = "Sun on Your Birthday"):
    """
    Upload image to Printful file storage.

    Parameters
    ----------
    image_path : str
        Path to the PNG file.
    title : str
        Optional name/description for the image in Printful.

    Returns
    -------
    dict
        JSON response from Printful.
    """
    with open(image_path, "rb") as f:
        resp = requests.post(
            f"{PRINTFUL_BASE_URL}/files",
            headers={"Authorization": f"Bearer {PRINTFUL_API_KEY}"},
            files={"file": (os.path.basename(image_path), f, "image/png")},
            data={"purpose": "poster", "filename": title}
        )
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# DRIVER
# ---------------------------------------------------------------------------

def generate_poster(date="1990-01-01", filter_func=None):
    """
    End-to-end poster generation pipeline.

    Parameters
    ----------
    date : str
        The observation date to visualize.
    filter_func : callable, optional
        Custom image filter.

    Returns
    -------
    dict
        Printful upload response.
    """
    smap = fetch_solar_fits(date)
    png_path = process_map_to_png(smap, filter_func=filter_func)
    print(f"[INFO] Saved processed image: {png_path}")

    if PRINTFUL_API_KEY:
        response = upload_to_printful(png_path, f"Sun on {date}")
        print(f"[INFO] Uploaded to Printful: {response.get('result', {}).get('id', 'N/A')}")
        return response
    else:
        print("[WARN] No Printful API key found. Skipping upload.")
        return {"local_path": png_path}


if __name__ == "__main__":
    generate_poster("2017-08-21")  # Example: solar eclipse date