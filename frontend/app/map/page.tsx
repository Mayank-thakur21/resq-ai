"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { MapIcon, Loader2, Filter } from "lucide-react";
import axios from "axios";

// Dynamically import the map component so it doesn't SSR and break due to 'window' not being defined
const MapComponent = dynamic(() => import("./MapComponent"), { ssr: false });

export default function MapPage() {
  const [location, setLocation] = useState<{lat: number; lon: number} | null>(null);
  const [hospitals, setHospitals] = useState([]);
  const [shelters, setShelters] = useState([]);
  const [police, setPolice] = useState([]);
  const [fire, setFire] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => alert("Please enable location to find nearby help.")
      );
    }
  }, []);

  const fetchNearby = async () => {
    if (!location) return;
    setLoading(true);
    try {
      const [hospRes, shelterRes, polRes, fireRes] = await Promise.all([
        axios.get(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/hospitals?lat=${location.lat}&lon=${location.lon}`),
        axios.get(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/shelters?lat=${location.lat}&lon=${location.lon}`),
        axios.get(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/police?lat=${location.lat}&lon=${location.lon}`),
        axios.get(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/fire-stations?lat=${location.lat}&lon=${location.lon}`)
      ]);
      setHospitals(hospRes.data.hospitals || []);
      setShelters(shelterRes.data.shelters || []);
      setPolice(polRes.data.police || []);
      setFire(fireRes.data.fire_stations || []);
    } catch (e) {
      console.error(e);
      alert("Error fetching nearby help.");
    }
    setLoading(false);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-80px)]">
      <div className="bg-white dark:bg-slate-950 border-b p-4 shadow-sm flex flex-col sm:flex-row justify-between items-center gap-4 z-10 relative">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2 text-slate-800 dark:text-slate-100">
            <MapIcon className="text-blue-600" /> Live Relief Map
          </h2>
          <p className="text-xs text-slate-500">Locating Hospitals, Shelters, Police, and Fire Stations</p>
        </div>
        
        <div className="flex gap-2">
          {/* Mock filters for UI polish */}
          <Button variant="outline" size="sm" className="hidden sm:flex gap-2">
            <Filter className="h-4 w-4" /> Filters
          </Button>
          <Button onClick={fetchNearby} disabled={!location || loading} className="bg-blue-600 hover:bg-blue-700 text-white min-w-[140px]">
            {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Scanning...</> : "Scan Radius"}
          </Button>
        </div>
      </div>
      
      <div className="flex-1 bg-slate-100 dark:bg-slate-900 relative z-0">
        {location ? (
          <MapComponent 
            location={location} 
            hospitals={hospitals} 
            shelters={shelters} 
            police={police} 
            fire={fire} 
          />
        ) : (
          <div className="flex h-full items-center justify-center flex-col gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            <p className="text-slate-500 font-medium">Acquiring GPS Signal...</p>
          </div>
        )}
        
        {/* Legend */}
        {location && (
          <div className="absolute bottom-6 left-6 z-[1000] bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm p-4 rounded-xl shadow-lg border border-slate-200 dark:border-slate-800 text-sm">
            <h4 className="font-semibold mb-2">Map Legend</h4>
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-red-600"></span> Hospitals</span>
              <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-green-600"></span> Shelters</span>
              <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-blue-600"></span> Police</span>
              <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-orange-500"></span> Fire Stations</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
