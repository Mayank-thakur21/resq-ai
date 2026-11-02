"""Weather endpoint: ``GET /api/weather?lat&lon`` (real data: OpenWeatherMap or Open-Meteo)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.common import Severity3

WeatherSource = Literal["openweathermap", "open-meteo"]


class CurrentWeather(BaseModel):
    """Current conditions (temperatures in degrees C, wind in km/h)."""

    temperature: float
    feels_like: float
    humidity: int = Field(ge=0, le=100)
    wind_speed_kmh: float = Field(ge=0)
    description: str
    #: OpenWeatherMap-style icon code, e.g. ``"10d"`` (Open-Meteo WMO codes are mapped).
    icon: str
    #: WMO weather code (Open-Meteo) or OWM condition id; ``None`` if unknown.
    weather_code: int | None = None
    #: City name (``None`` with Open-Meteo, which has no reverse geocoding).
    city: str | None = None
    #: ISO 3166-1 alpha-2 country code when known (e.g. ``"IN"``).
    country: str | None = None
    is_day: bool | None = None
    observed_at: datetime
    source: WeatherSource


class ForecastItem(BaseModel):
    time: datetime
    temperature: float
    description: str
    icon: str
    precipitation_probability: int | None = Field(default=None, ge=0, le=100)


class WeatherAlert(BaseModel):
    """Official alert (OpenWeatherMap One Call 3.0, when enabled)."""

    event: str
    description: str
    sender: str
    start: datetime | None = None
    end: datetime | None = None
    severity: Severity3


class Hazard(BaseModel):
    """Heuristic hazard derived from the data (extreme heat, high wind, heavy rain ...)."""

    type: str = Field(examples=["extreme_heat", "extreme_cold", "high_wind", "heavy_rain"])
    severity: Severity3
    message: str


class WeatherResponse(BaseModel):
    weather: CurrentWeather
    forecast: list[ForecastItem] = Field(default_factory=list)
    alerts: list[WeatherAlert] = Field(default_factory=list)
    hazards: list[Hazard] = Field(default_factory=list)
