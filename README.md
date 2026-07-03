<div align="center">
  <h1>ResQ AI</h1>
  <p><em>AI-Powered Disaster Response Platform</em></p>

  ![Next.js](https://img.shields.io/badge/Next.js-15-black?style=for-the-badge&logo=next.js)
  ![FastAPI](https://img.shields.io/badge/FastAPI-0.110.0-009688?style=for-the-badge&logo=fastapi)
  ![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=for-the-badge&logo=python)
  ![Gemini API](https://img.shields.io/badge/Google%20Gemini-Free%20API-4285F4?style=for-the-badge&logo=google)
  ![Agents for Good](https://img.shields.io/badge/Track-Agents%20for%20Good-FF6B6B?style=for-the-badge)
  ![Open Source](https://img.shields.io/badge/Open%20Source-Yes-brightgreen?style=for-the-badge)
  ![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)
</div>

<br />

## 📖 Table of Contents
- [Overview](#-overview)
- [Why ResQ AI](#-why-resq-ai)
- [Features](#-features)
- [Architecture](#-architecture)
- [Multi-Agent Workflow](#-multi-agent-workflow)
- [Tech Stack](#-tech-stack)
- [Folder Structure](#-folder-structure)
- [Environment Variables](#-environment-variables)
- [Installation](#-installation)
- [API Endpoints](#-api-endpoints)
- [Deployment](#-deployment)
- [Security](#-security)
- [Screenshots](#-screenshots)
- [Demo](#-demo)
- [Future Improvements](#-future-improvements)
- [Contributing](#-contributing)
- [Acknowledgements](#-acknowledgements)
- [License](#-license)

---

## 🌍 Overview
**ResQ AI** is a state-of-the-art, AI-powered disaster response assistant designed to help users before, during, and after natural disasters. Built for rapid deployment and accessibility, the platform uses an intelligent multi-agent backend to provide immediate safety guidance, locate nearby emergency services, and generate dynamic survival checklists.

---

## ❓ Why ResQ AI
During natural disasters, individuals face immense challenges:
- **Misinformation & Panic**: Unreliable data leads to dangerous decisions.
- **Delayed Assistance**: Locating the nearest hospital, shelter, or police station during a crisis is often difficult.
- **Multilingual Barriers**: Non-native speakers often struggle to understand critical emergency broadcasts.
- **Lack of Centralized Guidance**: Information is scattered across weather apps, news stations, and social media.

**ResQ AI** solves these issues by offering a centralized, AI-driven emergency dashboard that autonomously coordinates weather data, relief maps, and customized survival instructions in real-time.

---

## 🚀 Features
- **Multi-Agent Emergency Dashboard**: A modern, glassmorphic UI with micro-animations offering mock live alerts and dynamic weather data.
- **AI Emergency Chat (Agent Visualizer)**: Conversational interface that analyzes urgency and disaster types, featuring an animated "Agent Trace" that visualizes the AI's internal logic.
- **Multilingual Voice Support**: Integrated STT (Browser Web Speech API) and TTS (Browser SpeechSynthesis API) for accessibility.
- **Live Relief Map**: Interactive map displaying 100% free location data for Hospitals, Shelters, Police Stations, and Fire Stations.
- **Smart Interactive Checklists**: AI-tailored disaster packing lists with PDF export and printing capabilities.
- **SOS Contacts Manager**: Save trusted contacts locally and quickly share pre-built distress messages appended with GPS coordinates via WhatsApp or Web Share APIs.

---

## 🧠 Architecture
ResQ AI operates on a modern decoupled architecture:

```text
User
  ↓
Next.js Frontend (UI & State)
  ↓
FastAPI Backend (REST API)
  ↓
Router Agent (Intent Classification)
  ↓
Safety Agent ↔ Mapping Agent ↔ Checklist Agent ↔ Advisory Agent
  ↓
Google Gemini Free API (LLM Orchestration)
```

---

## 🤖 Multi-Agent Workflow
Our backend leverages a synchronized swarm of AI agents to handle crisis data:
- **Router Agent**: Analyzes user input to classify the disaster type, urgency, and intent. It then delegates the task to the specialized agents below.
- **Safety Agent**: Fetches and structures immediate, critical safety protocols based on the disaster type.
- **Mapping Agent**: Queries OpenStreetMap (Overpass API) to locate the nearest emergency amenities based on GPS coordinates.
- **Checklist Agent**: Dynamically generates tailored survival kits (e.g., "Flood Preparedness Kit").
- **Advisory Agent**: Fetches real-time weather alerts via Open-Meteo and summarizes them into simple safety language.
- **Translation Agent**: Ensures the final compiled response is delivered in the user's preferred language.

---

## 🛠 Tech Stack

### Frontend
- **Framework**: Next.js 15 (React)
- **Styling**: TailwindCSS, shadcn/ui
- **Animations**: Framer Motion
- **Maps**: React-Leaflet

### Backend
- **Framework**: FastAPI (Python)
- **Server**: Uvicorn

### External APIs & Data
- **AI**: Google Gemini Free API (`google-generativeai`)
- **Maps/Geocoding**: OpenStreetMap, Overpass API, Nominatim
- **Weather**: Open-Meteo
- **Speech**: Browser Web Speech API & SpeechSynthesis

### Database & Storage
- **Storage**: LocalStorage (Contacts & Offline Data)

### Recommended Deployment
- **Frontend**: Vercel (Free)
- **Backend**: Render (Free)

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

## 🔐 Environment Variables
Never commit these files to version control. Use `.env.example` as a template.

### Backend (`backend/.env`)
```env
GEMINI_API_KEY=your_gemini_api_key_here
```

### Frontend (`frontend/.env.local`)
```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

---

## 🏃 Installation

### Prerequisites
- Node.js (v18+)
- Python (3.11+)
- Git

### Backend Setup
1. Clone the repository and navigate to the backend:
   ```bash
   git clone https://github.com/Mayank-thakur21/resq-ai.git
   cd resq-ai/backend
   ```
2. Create and activate a virtual environment:
   ```bash
   # Windows
   python -m venv venv
   .\venv\Scripts\Activate

   # macOS/Linux
   python3 -m venv venv
   source venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Copy the environment variables:
   ```bash
   cp .env.example .env
   ```
5. Get a [Free Google Gemini API Key](https://aistudio.google.com/) and paste it into `backend/.env`.
6. Run the development server:
   ```bash
   uvicorn app.main:app --reload
   ```
   *(Server runs on `http://localhost:8000`)*

### Frontend Setup
1. Open a new terminal and navigate to the frontend:
   ```bash
   cd resq-ai/frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the environment variables:
   ```bash
   cp .env.example .env.local
   ```
4. Run the development server:
   ```bash
   npm run dev
   ```
5. Open `http://localhost:3000` in your browser.

---

## 🔌 API Endpoints
The backend exposes the following RESTful endpoints:

- `GET /api/health` - Server health check
- `POST /api/chat` - Processes user messages via the Multi-Agent Pipeline
- `POST /api/classify` - Classifies disaster intent and urgency
- `GET /api/shelters` - Fetches nearby emergency shelters
- `GET /api/hospitals` - Fetches nearby hospitals
- `GET /api/police` - Fetches nearby police stations
- `GET /api/fire-stations` - Fetches nearby fire stations
- `GET /api/advisories` - Fetches and summarizes weather alerts
- `POST /api/checklist` - Generates disaster-specific packing lists
- `POST /api/translate` - Translates emergency text

---

## 🚀 Deployment
This project is optimized for free-tier hosting:
- **Frontend**: Deploy `frontend/` on [Vercel](https://vercel.com/) for zero-config Next.js hosting.
- **Backend**: Deploy `backend/` on [Render](https://render.com/) via a web service (using `uvicorn app.main:app --host 0.0.0.0 --port 10000`).

---

## 🛡 Security
Security and privacy are paramount in crisis situations:
- **No Secrets Committed**: All API keys are stored in strictly `.gitignored` `.env` files.
- **No Paid Dependencies**: By relying on OpenStreetMap and Gemini Free API, the app prevents unexpected cloud billing attacks.
- **Local Browser Storage**: Personal emergency contacts are saved strictly in `LocalStorage`, ensuring sensitive PII is never transmitted to our servers.

---

## 📸 Screenshots
*(Coming Soon after hackathon submission)*
- Home Dashboard
- AI Chat
- Relief Map
- Smart Checklist
- SOS Contacts

---

## 🎥 Demo
- **Live Demo**: *(Coming Soon after deployment)*
- **Demo Video**: *(Coming Soon)*

---

## 🔮 Future Improvements
While the MVP is complete, the following features are planned for future iterations:
- **Offline PWA Support**: Ensuring users can access cached safety guides when cellular networks fail.
- **Supabase Integration**: Moving contacts and profiles to a managed database with robust authentication.
- **Volunteer Network**: A peer-to-peer check-in system for community rescue efforts.
- **Admin Dashboard**: For local authorities to broadcast verified alerts.
- **Push Notifications**: Real-time SMS or push alerts for imminent danger.

---

## 🤝 Contributing
We welcome contributions from developers, designers, and crisis-management experts!
1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 🙏 Acknowledgements
This project would not be possible without the incredible open-source tools and free APIs provided by:
- **Google Gemini** (AI Orchestration)
- **FastAPI & Next.js** (Core Frameworks)
- **OpenStreetMap & Overpass API** (Relief Mapping)
- **Open-Meteo** (Weather Advisories)
- **Leaflet** (Map Rendering)
- **Tailwind CSS & shadcn/ui** (Design System)

---

## 📜 License
Distributed under the MIT License. See `LICENSE` for more information.
