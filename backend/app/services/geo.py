"""Geodesy helpers: great-circle distance, bounding boxes and coordinate validation."""

from __future__ import annotations

import math
from typing import NamedTuple

from app.core.errors import InvalidInputError

#: Mean Earth radius (IUGG) in kilometres.
EARTH_RADIUS_KM = 6371.0088
#: Kilometres per degree of latitude (and of longitude at the equator).
KM_PER_DEGREE = math.pi * EARTH_RADIUS_KM / 180.0


class BoundingBox(NamedTuple):
    """Axis-aligned lat/lon box. ``min_lon=-180, max_lon=180`` when it wraps the antimeridian."""

    min_lat: float
    max_lat: float
    min_lon: float
    max_lon: float

    def contains(self, lat: float, lon: float) -> bool:
        return self.min_lat <= lat <= self.max_lat and self.min_lon <= lon <= self.max_lon


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two WGS84 points in kilometres."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def bounding_box(lat: float, lon: float, radius_km: float) -> BoundingBox:
    """Conservative box containing every point within ``radius_km`` of (lat, lon).

    Use it as a cheap SQL pre-filter, then confirm with :func:`haversine_km`. Near the poles
    or when the box crosses the antimeridian the longitude range widens to [-180, 180].
    """
    if radius_km < 0:
        raise ValueError("radius_km must be >= 0")
    d_lat = radius_km / KM_PER_DEGREE
    min_lat = max(-90.0, lat - d_lat)
    max_lat = min(90.0, lat + d_lat)

    cos_lat = math.cos(math.radians(lat))
    if max_lat >= 90.0 or min_lat <= -90.0 or cos_lat < 1e-9:
        return BoundingBox(min_lat, max_lat, -180.0, 180.0)
    d_lon = radius_km / (KM_PER_DEGREE * cos_lat)
    if d_lon >= 180.0:
        return BoundingBox(min_lat, max_lat, -180.0, 180.0)
    min_lon = lon - d_lon
    max_lon = lon + d_lon
    if min_lon < -180.0 or max_lon > 180.0:
        return BoundingBox(min_lat, max_lat, -180.0, 180.0)
    return BoundingBox(min_lat, max_lat, min_lon, max_lon)


def is_valid_lat(lat: float) -> bool:
    return isinstance(lat, int | float) and math.isfinite(lat) and -90.0 <= lat <= 90.0


def is_valid_lon(lon: float) -> bool:
    return isinstance(lon, int | float) and math.isfinite(lon) and -180.0 <= lon <= 180.0


def validate_coordinates(lat: float, lon: float) -> tuple[float, float]:
    """Return ``(lat, lon)`` as floats or raise :class:`InvalidInputError` (422)."""
    if not is_valid_lat(lat):
        raise InvalidInputError("lat must be a number between -90 and 90")
    if not is_valid_lon(lon):
        raise InvalidInputError("lon must be a number between -180 and 180")
    return float(lat), float(lon)


def round_coord(value: float, ndigits: int = 2) -> float:
    """Round a coordinate for cache keys (2 digits ~= 1.1 km)."""
    rounded = round(value, ndigits)
    return 0.0 if rounded == 0 else rounded  # normalise -0.0


def clamp(value: float, low: float, high: float) -> float:
    """Clamp ``value`` into ``[low, high]``."""
    return max(low, min(high, value))
