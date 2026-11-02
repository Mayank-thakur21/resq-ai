# 🆘 ResQ AI — Intelligent Disaster Response Platform

![CI](https://github.com/Mayank-thakur21/resq-ai/actions/workflows/ci.yml/badge.svg)
![Next.js](https://img.shields.io/badge/Next.js-15-black)
![FastAPI](https://img.shields.io/badge/FastAPI-0.111-green)
![License](https://img.shields.io/badge/license-MIT-yellow)
![PWA](https://img.shields.io/badge/PWA-ready-blue)

ResQ AI is a full-stack disaster response platform powered by multi-agent AI. It provides real-time emergency guidance, relief map, weather alerts, SOS messaging, and community incident reporting.

---

## ✨ Features

| Feature | Description |
|--------|-------------|
| 🤖 Emergency AI Chat | Multi-agent AI for life-saving protocols |
| 🗺️ Live Relief Map | Hospitals, shelters, police, fire stations |
| ☁️ Real Weather | Live weather & disaster alerts (OpenWeatherMap) |
| 🆘 SOS Button | One-tap SOS with SMS to emergency contacts (Twilio) |
| 📋 Smart Checklists | AI-generated disaster preparedness checklists |
| 🚨 Incident Reporting | Community disaster reporting with upvotes |
| 🌍 Multi-language | Translation support for emergency info |
| 📱 PWA Support | Install on phone, works offline |
| 🐳 Docker Ready | One-command deployment |

---

## 🚀 Quick Start

### Option 1: Docker (Recommended)
```bash
git clone https://github.com/Mayank-thakur21/resq-ai
cd resq-ai
cp backend/.env.example backend/.env
# Edit backend/.env with your API keys
docker-compose up --build
```
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000/docs

### Option 2: Manual
```bash
# Backend
cd backend
pip install -r requirements.txt
cp .env.example .env  # Add your API keys
uvicorn app.main:app --reload

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

---

## 🔑 API Keys Required

| Service | Purpose | Free Tier |
|---------|---------|-----------|
| [Google Gemini](https://aistudio.google.com) | AI chat & agents | ✅ Yes |
| [OpenWeatherMap](https://openweathermap.org/api) | Real weather data | ✅ Yes |
| [Twilio](https://twilio.com) | SOS SMS alerts | ✅ Trial |

---

## 📡 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat` | Emergency AI chat |
| GET | `/api/weather` | Real-time weather + alerts |
| POST | `/api/sos` | Trigger SOS with SMS |
| GET | `/api/shelters` | Nearby shelters |
| GET | `/api/hospitals` | Nearby hospitals |
| POST | `/api/incidents` | Report an incident |
| GET | `/api/incidents` | List nearby incidents |
| POST | `/api/checklist` | Generate preparedness checklist |
| POST | `/api/translate` | Translate emergency info |

---

## 🏗️ Project Structure
```
resq-ai/
├── backend/
│   ├── app/
│   │   ├── agents/
│   │   │   ├── router_agent.py      # Main AI dispatcher
│   │   │   ├── mapping_agent.py     # Location services
│   │   │   ├── weather_agent.py     # Real weather API
│   │   │   ├── sos_agent.py         # SOS + Twilio SMS
│   │   │   ├── incident_agent.py    # Community reporting
│   │   │   ├── checklist_agent.py   # Preparedness checklists
│   │   │   ├── translation_agent.py # Multi-language support
│   │   │   └── advisory_agent.py    # Disaster advisories
│   │   ├── api/endpoints.py
│   │   ├── models/schemas.py
│   │   └── main.py
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
├── frontend/
│   ├── app/                         # Next.js pages
│   ├── components/                  # Reusable UI components
│   ├── public/manifest.json         # PWA manifest
│   └── Dockerfile
├── .github/workflows/ci.yml
├── docker-compose.yml
└── README.md
```

---

## 📱 PWA Installation
ResQ AI works offline and can be installed on your phone:
1. Open the app in Chrome/Safari
2. Tap the "Install" or "Add to Home Screen" prompt
3. The app is now available offline with cached data

---

## 🆘 SOS Feature
The SOS panic button sends your GPS location via SMS to your emergency contacts using Twilio.
Configure contacts in the **SOS & Contacts** page.

---

## 📄 License
MIT © Mayank Thakur
