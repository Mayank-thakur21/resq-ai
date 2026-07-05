import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Custom icons
const createIcon = (color: string) => new L.Icon({
  iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-${color}.png`,
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

const hospitalIcon = createIcon('red');
const shelterIcon = createIcon('green');
const policeIcon = createIcon('blue');
const fireIcon = createIcon('orange');

type Amenity = { lat: number; lon: number; name: string };

type MapProps = {
  location: { lat: number; lon: number };
  hospitals: Amenity[];
  shelters: Amenity[];
  police: Amenity[];
  fire: Amenity[];
};

function ChangeView({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  map.setView(center, zoom);
  return null;
}

export default function MapComponent({ location, hospitals, shelters, police, fire }: MapProps) {
  return (
    <MapContainer 
      center={[location.lat, location.lon]} 
      zoom={14} 
      style={{ height: "100%", width: "100%", zIndex: 0 }}
      zoomControl={false}
    >
      <ChangeView center={[location.lat, location.lon]} zoom={14} />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      
      {/* User Location */}
      <Marker position={[location.lat, location.lon]}>
        <Popup>You are here</Popup>
      </Marker>

      {/* Hospitals */}
      {hospitals.map((hosp: Amenity, i) => (
        <Marker key={`hosp-${i}`} position={[hosp.lat, hosp.lon]} icon={hospitalIcon}>
          <Popup>
            <div className="font-bold text-red-600">🏥 {hosp.name}</div>
            <div className="text-xs text-gray-500">Hospital</div>
          </Popup>
        </Marker>
      ))}

      {/* Shelters */}
      {shelters.map((shelter: Amenity, i) => (
        <Marker key={`shel-${i}`} position={[shelter.lat, shelter.lon]} icon={shelterIcon}>
          <Popup>
            <div className="font-bold text-green-600">⛺ {shelter.name}</div>
            <div className="text-xs text-gray-500">Emergency Shelter</div>
          </Popup>
        </Marker>
      ))}

      {/* Police */}
      {police.map((pol: Amenity, i) => (
        <Marker key={`pol-${i}`} position={[pol.lat, pol.lon]} icon={policeIcon}>
          <Popup>
            <div className="font-bold text-blue-600">🚓 {pol.name}</div>
            <div className="text-xs text-gray-500">Police Station</div>
          </Popup>
        </Marker>
      ))}

      {/* Fire */}
      {fire.map((f: Amenity, i) => (
        <Marker key={`fire-${i}`} position={[f.lat, f.lon]} icon={fireIcon}>
          <Popup>
            <div className="font-bold text-orange-600">🚒 {f.name}</div>
            <div className="text-xs text-gray-500">Fire Station</div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
