import httpx

async def get_nearby_amenities(lat: float, lon: float, amenity: str = "hospital", radius: int = 5000) -> list:
    """
    Fetches nearby amenities (e.g., hospital, shelter) using OpenStreetMap's Overpass API.
    """
    # Overpass QL query
    query = f"""
    [out:json];
    (
      node["amenity"="{amenity}"](around:{radius},{lat},{lon});
      way["amenity"="{amenity}"](around:{radius},{lat},{lon});
      relation["amenity"="{amenity}"](around:{radius},{lat},{lon});
    );
    out center;
    """
    
    url = "https://overpass-api.de/api/interpreter"
    
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, data={"data": query})
            data = response.json()
            
            results = []
            for element in data.get("elements", []):
                # nodes have lat/lon directly, ways/relations have center
                element_lat = element.get("lat") or element.get("center", {}).get("lat")
                element_lon = element.get("lon") or element.get("center", {}).get("lon")
                name = element.get("tags", {}).get("name", f"Unknown {amenity}")
                
                if element_lat and element_lon:
                    results.append({
                        "id": element.get("id"),
                        "name": name,
                        "lat": element_lat,
                        "lon": element_lon,
                        "type": amenity
                    })
            return results
    except Exception as e:
        print(f"Overpass API Error: {e}")
        return []

async def get_nearby_hospitals(lat: float, lon: float, radius: int = 5000) -> list:
    return await get_nearby_amenities(lat, lon, "hospital", radius)

async def get_nearby_shelters(lat: float, lon: float, radius: int = 5000) -> list:
    return await get_nearby_amenities(lat, lon, "social_facility", radius)
