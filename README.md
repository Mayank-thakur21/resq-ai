# ResQ AI - Disaster Response Agent

![ResQ AI](https://img.shields.io/badge/ResQ%20AI-Emergency%20Response-blue.svg?style=for-the-badge)

ResQ AI is a state-of-the-art, AI-powered disaster response assistant that helps users before, during, and after natural disasters. Designed for hackathons and rapid deployment, it provides an intelligent multi-agent backend and a highly polished, responsive frontend.

## 🚀 Features

### 1. **Multi-Agent Emergency Dashboard**
- Modern UI with Glassmorphism and **Framer Motion** micro-animations.
- **Live Alert Banners** and dynamic mock weather integrations.

### 2. **AI Emergency Chat (Agent Visualizer)**
- Uses a **Multi-Agent Pipeline** architecture (Router, Advisory, Checklist, Mapping).
- **Agent Trace Visualizer**: Watch the AI "think" and execute actions in real-time.
- **Structured Emergency Data**: Badges for Urgency and Disaster Type, with actionable advice.
- **Voice Support**: Integrated STT (Microphone) and TTS (Speech Synthesis).

### 3. **Live Relief Map**
- Uses **OpenStreetMap** and **Overpass API** for 100% free location data.
- Plots **Hospitals, Emergency Shelters, Police Stations, and Fire Stations**.
- Custom color-coded Leaflet markers.

### 4. **Smart Interactive Checklists**
- AI-tailored checklists based on disaster type.
- Interactive checkboxes with progress tracking.
- **Export to PDF (jsPDF & html2canvas)** and Print capabilities for offline use.

### 5. **SOS & Contacts Manager**
- Save trusted contacts securely via **LocalStorage**.
- Pre-built **"I'm Safe"** and **"I Need Help"** distress messages.
- Append last known location (GPS).
- **Share Intents**: Web Share API, WhatsApp deep linking, and Clipboard copy.

## 🛠 Tech Stack

- **Frontend**: Next.js 15, React, TailwindCSS, shadcn/ui, Framer Motion, React-Leaflet
- **Backend**: FastAPI, Python, Uvicorn, g4f (GPT4Free)
- **Database**: LocalStorage (Contacts), Supabase (Ready)
- **Open Data**: OpenStreetMap, Overpass API, Open-Meteo

## 🏃 Getting Started

### Prerequisites
- Node.js (v18+)
- Python (3.11+)

### Backend Setup
1. Navigate to the `backend` directory.
2. Create and activate a virtual environment:
   ```bash
   python -m venv venv
   # Windows:
   .\venv\Scripts\Activate
   ```
3. Install dependencies: `pip install -r requirements.txt`
4. Run the server: `uvicorn app.main:app --reload`
   *(Runs on `http://localhost:8000`)*

### Frontend Setup
1. Navigate to the `frontend` directory.
2. Install dependencies: `npm install`
3. Run the development server: `npm run dev`
4. Open `http://localhost:3000` in your browser.

## 🛡 License
MIT License
