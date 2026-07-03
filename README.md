# ResQ AI - Disaster Response Agent

ResQ AI is an AI-powered disaster response assistant that helps users before, during, and after natural disasters. It provides intelligent chat responses, nearby shelter and hospital mapping, dynamic emergency checklists, real-time government/weather advisories, and emergency contact SOS management.

## Tech Stack
- **Frontend**: Next.js 15, React, TailwindCSS, shadcn/ui, Leaflet
- **Backend**: FastAPI, Python, Uvicorn, g4f (Free AI)
- **Database**: Supabase (Free Tier)
- **Maps**: OpenStreetMap & Overpass API (Free)
- **Weather/Advisories**: Open-Meteo API (Free)

## Features
1. **AI Emergency Chat**: Detects disaster type and urgency, providing immediate safe actions. Uses Web Speech API for voice support.
2. **Nearby Help Map**: Displays hospitals and shelters using OpenStreetMap Leaflet integration.
3. **Emergency Checklists**: Generates dynamic kits using AI.
4. **Emergency Contacts**: Prepare and send SOS messages to trusted contacts.

## Getting Started

### Prerequisites
- Node.js (v18+)
- Python (3.11+)

### Backend Setup
1. Navigate to the `backend` directory.
2. Create a virtual environment: `python -m venv venv`
3. Activate the virtual environment.
4. Install dependencies: `pip install -r requirements.txt` (or install manually).
5. Copy `.env.example` to `.env` (No API keys needed for core AI functionality).
6. Run the server: `uvicorn app.main:app --reload`

### Frontend Setup
1. Navigate to the `frontend` directory.
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env.local` and add Supabase keys if needed.
4. Run the development server: `npm run dev`
5. Open `http://localhost:3000` in your browser.
