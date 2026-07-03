# ResQ AI - Disaster Response Agent

![ResQ AI](https://img.shields.io/badge/ResQ%20AI-Emergency%20Response-blue.svg?style=for-the-badge)

ResQ AI is a state-of-the-art, AI-powered disaster response assistant that helps users before, during, and after natural disasters. Designed for rapid deployment, it provides an intelligent multi-agent backend and a highly polished, responsive frontend.

---

## 🏆 Hackathon Info
- **Track**: Agents for Good
- **Project**: ResQ AI
- **Theme**: AI-powered Disaster Response Platform

---

## 📸 Screenshots
*(Coming Soon)*
- Home Dashboard
- AI Chat
- Relief Map
- Smart Checklist
- SOS Contacts

---

## 🎥 Demo
- **Demo Video**: *(Coming Soon)*
- **Live Demo**: *(Coming Soon)*

---

## 🚀 Features

### 1. **Multi-Agent Emergency Dashboard**
- Modern UI with Glassmorphism and **Framer Motion** micro-animations.
- **Live Alert Banners** and dynamic placeholder integrations.

### 2. **AI Emergency Chat (Agent Visualizer)**
- Uses a **Multi-Agent Pipeline** architecture (Router, Advisory, Checklist, Mapping).
- **Agent Trace Visualizer**: Watch the AI "think" and execute actions in real-time.
- **Structured Emergency Data**: Badges for Urgency and Disaster Type, with actionable advice.
- **Voice Support**: Integrated STT (Browser Web Speech API) and TTS (Browser SpeechSynthesis API).

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

---

## 🧠 Architecture

```text
User
  ↓
Next.js Frontend
  ↓
FastAPI Backend
  ↓
Router Agent
  ↓
Safety Agent ↔ Mapping Agent ↔ Checklist Agent ↔ Advisory Agent
  ↓
Google Gemini Free API
```

---

## 📂 Folder Structure

```text
resq-ai/
├── backend/          # FastAPI Python backend (Agents, Endpoints)
├── frontend/         # Next.js 15 React frontend (UI, Pages, Components)
├── README.md         # Project documentation
├── PROJECT.md        # Project setup guidelines
└── .gitignore        # Git ignore rules
```

---

## 🛠 Tech Stack

- **Frontend**: Next.js 15, React, TailwindCSS, shadcn/ui, Framer Motion, React-Leaflet
- **Backend**: FastAPI, Python, Uvicorn
- **AI**: Google Gemini Free API (`google-generativeai`)
- **Database**: LocalStorage (Contacts)
- **Open Data**: OpenStreetMap, Overpass API, Open-Meteo

---

## 🔐 Environment Variables

Never commit these files to version control. They are ignored in `.gitignore`.

### Backend (`backend/.env`)
```env
GEMINI_API_KEY=your_api_key_here
```

### Frontend (`frontend/.env.local`)
```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

---

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
4. Copy the environment variables:
   ```bash
   cp .env.example .env
   ```
5. Get a [Free Google Gemini API Key](https://aistudio.google.com/) and paste it into `backend/.env`.
6. Run the server: `uvicorn app.main:app --reload`
   *(Runs on `http://localhost:8000`)*

### Frontend Setup
1. Navigate to the `frontend` directory.
2. Install dependencies: `npm install`
3. Copy the environment variables:
   ```bash
   cp .env.example .env.local
   ```
4. Run the development server: `npm run dev`
5. Open `http://localhost:3000` in your browser.

---

## 🌍 Deployment

Recommended free-tier hosting for this project:

- **Frontend**: [Vercel](https://vercel.com/) (Free)
- **Backend**: [Render](https://render.com/) (Free)
- **Maps**: OpenStreetMap (Free)
- **Weather**: Open-Meteo (Free)
- **AI**: Google Gemini (Free API)

---

## 🔮 Future Improvements

- Supabase Integration (Auth & DB)
- Offline PWA Support
- Volunteer Network & Check-in System
- Admin Dashboard
- Push Notifications

---

## 🛡 License
MIT License
