# ResQ AI Architecture

## 1. System Overview
ResQ AI is split into a **Next.js 15 Frontend** and a **FastAPI Python Backend**. 

## 2. Frontend
- Built with React Server Components (where applicable) and Client Components for interactive pages.
- UI elements constructed via TailwindCSS and shadcn/ui.
- Leaflet integration via `react-leaflet` to visualize mapping data without relying on paid map providers (using OpenStreetMap).
- Browser's Web Speech API is utilized for zero-cost Voice-to-Text.

## 3. Backend & AI Agents
The backend uses a Clean Architecture routing model where a central `Router Agent` analyzes the user query and dispatches it to specific functional agents:
1. **Safety Agent**: Fetches basic safety protocols (uses OpenAI gpt-4o-mini).
2. **Mapping Agent**: Uses OpenStreetMap Overpass API (free) to fetch coordinates of hospitals and shelters.
3. **Checklist Agent**: Dynamically formulates supply lists tailored to a disaster.
4. **Advisory Agent**: Uses Open-Meteo for free weather alerts and summarizes them via AI.
5. **Translation Agent**: Ensures multi-lingual support (English/Hindi).

## 4. API Endpoints
- `POST /api/chat` -> Main conversational AI handler
- `POST /api/classify` -> Disaster classification
- `GET /api/shelters` -> Fetch shelters via Overpass
- `GET /api/hospitals` -> Fetch hospitals via Overpass
- `GET /api/advisories` -> Fetch weather advisories via Open-Meteo
- `POST /api/checklist` -> Generate emergency kit checklist
- `POST /api/translate` -> Text translation

## 5. Deployment
- The backend is optimized for environments like Render, Heroku, or Vercel Serverless.
- The frontend is optimized for Vercel.
