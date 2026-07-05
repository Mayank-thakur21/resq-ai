"use client";

import Link from "next/link";
import { ShieldAlert, Map as MapIcon, PhoneCall, ListChecks, CloudLightning, Info, X, Wind, Droplets, ThermometerSun, Radio } from "lucide-react";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

const safetyTips = [
  "Store at least 3 days of drinking water (1 gallon per person per day).",
  "Keep a printed copy of emergency contacts.",
  "Identify safe spots in your home for earthquakes (under sturdy furniture).",
  "Have a battery-powered radio and extra batteries.",
  "Create an evacuation plan and practice it with your family."
];

const mockNews = [
  { id: 1, title: "National Weather Service issues severe thunderstorm watch for coastal regions.", time: "2 hours ago" },
  { id: 2, title: "Local authorities announce new community shelter locations.", time: "5 hours ago" },
  { id: 3, title: "Emergency drill scheduled for next Tuesday in downtown.", time: "1 day ago" }
];

export default function Home() {
  const [showAlert, setShowAlert] = useState(true);
  const [tipIndex, setTipIndex] = useState(0);

  useEffect(() => {
    // Randomize tip on load
    setTipIndex(Math.floor(Math.random() * safetyTips.length));
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-black text-white overflow-hidden pb-12">
      
      {/* Live Alert Banner */}
      <AnimatePresence>
        {showAlert && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-red-600/90 backdrop-blur-sm border-b border-red-500"
          >
            <div className="container mx-auto px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="flex h-3 w-3 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-white"></span>
                </span>
                <div>
                  <p className="font-bold text-sm tracking-wide uppercase">⚠ Flood Warning - High Risk</p>
                  <p className="text-xs text-red-100">Ahmedabad • Updated 5 minutes ago</p>
                </div>
              </div>
              <button onClick={() => setShowAlert(false)} className="p-1 hover:bg-red-500 rounded-full transition-colors">
                <X className="h-5 w-5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="container mx-auto px-4 pt-12 lg:pt-20">
        
        {/* Hero Section */}
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-4xl mx-auto mb-16"
        >
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6 bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-cyan-300 to-emerald-400 drop-shadow-sm">
            ResQ AI
          </h1>
          <p className="text-xl md:text-2xl text-slate-300 font-light max-w-2xl mx-auto leading-relaxed">
            Your intelligent disaster response platform. Real-time guidance, offline maps, and multi-agent AI assistance.
          </p>
        </motion.div>

        {/* Dashboard Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-6xl mx-auto">
          
          {/* Main Actions (Left/Center) */}
          <div className="lg:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Link href="/chat" className="group">
              <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="h-full bg-red-600/20 hover:bg-red-600/30 border border-red-500/30 rounded-2xl p-6 transition-colors relative overflow-hidden backdrop-blur-md">
                <div className="absolute -right-4 -top-4 opacity-10 group-hover:scale-110 transition-transform"><ShieldAlert size={120} /></div>
                <ShieldAlert className="h-10 w-10 text-red-400 mb-4" />
                <h3 className="text-2xl font-bold mb-2">Emergency AI Chat</h3>
                <p className="text-slate-300 text-sm">Talk to our multi-agent AI for immediate life-saving protocols and situational awareness.</p>
              </motion.div>
            </Link>

            <Link href="/map" className="group">
              <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="h-full bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 rounded-2xl p-6 transition-colors relative overflow-hidden backdrop-blur-md">
                <div className="absolute -right-4 -top-4 opacity-10 group-hover:scale-110 transition-transform"><MapIcon size={120} /></div>
                <MapIcon className="h-10 w-10 text-blue-400 mb-4" />
                <h3 className="text-2xl font-bold mb-2">Live Relief Map</h3>
                <p className="text-slate-300 text-sm">Locate nearby hospitals, shelters, fire stations, and police dynamically.</p>
              </motion.div>
            </Link>

            <Link href="/checklist" className="group">
              <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="h-full bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 rounded-2xl p-6 transition-colors relative overflow-hidden backdrop-blur-md">
                <div className="absolute -right-4 -top-4 opacity-10 group-hover:scale-110 transition-transform"><ListChecks size={120} /></div>
                <ListChecks className="h-10 w-10 text-emerald-400 mb-4" />
                <h3 className="text-2xl font-bold mb-2">Smart Checklists</h3>
                <p className="text-slate-300 text-sm">Interactive preparedness checklists for floods, earthquakes, fires and more.</p>
              </motion.div>
            </Link>

            <Link href="/contacts" className="group">
              <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="h-full bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 rounded-2xl p-6 transition-colors relative overflow-hidden backdrop-blur-md">
                <div className="absolute -right-4 -top-4 opacity-10 group-hover:scale-110 transition-transform"><PhoneCall size={120} /></div>
                <PhoneCall className="h-10 w-10 text-purple-400 mb-4" />
                <h3 className="text-2xl font-bold mb-2">SOS & Contacts</h3>
                <p className="text-slate-300 text-sm">One-click SOS messaging and critical offline contact management.</p>
              </motion.div>
            </Link>
          </div>

          {/* Info Panels (Right) */}
          <div className="lg:col-span-4 flex flex-col gap-4">
            
            {/* Weather Card */}
            <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 }} className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6 backdrop-blur-md">
              <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">
                <CloudLightning className="h-4 w-4" /> Current Conditions
              </h4>
              <div className="flex items-end justify-between">
                <div>
                  <span className="text-5xl font-light">32°</span>
                  <span className="text-xl text-slate-400 ml-1">C</span>
                </div>
                <div className="text-right">
                  <p className="font-medium text-amber-400">Severe Heat</p>
                  <p className="text-xs text-slate-400 mt-1">Delhi, India</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-6 border-t border-slate-700/50 pt-4">
                <div className="text-center">
                  <Wind className="h-4 w-4 mx-auto text-slate-400 mb-1" />
                  <span className="text-xs text-slate-300">12 km/h</span>
                </div>
                <div className="text-center border-l border-r border-slate-700/50">
                  <Droplets className="h-4 w-4 mx-auto text-slate-400 mb-1" />
                  <span className="text-xs text-slate-300">45%</span>
                </div>
                <div className="text-center">
                  <ThermometerSun className="h-4 w-4 mx-auto text-slate-400 mb-1" />
                  <span className="text-xs text-slate-300">High UV</span>
                </div>
              </div>
            </motion.div>

            {/* Daily Tip */}
            <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 }} className="bg-gradient-to-br from-indigo-900/40 to-blue-900/40 border border-indigo-500/30 rounded-2xl p-6 backdrop-blur-md">
              <h4 className="flex items-center gap-2 text-sm font-semibold text-indigo-300 uppercase tracking-wider mb-3">
                <Info className="h-4 w-4" /> Preparedness Tip
              </h4>
              <p className="text-slate-200 text-sm italic leading-relaxed">
                &quot;{safetyTips[tipIndex]}&quot;
              </p>
            </motion.div>
            
            {/* Disaster News */}
            <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.4 }} className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6 backdrop-blur-md flex-grow">
              <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">
                <Radio className="h-4 w-4" /> Latest Advisories
              </h4>
              <div className="space-y-4">
                {mockNews.map((news) => (
                  <div key={news.id} className="border-b border-slate-700/50 pb-3 last:border-0 last:pb-0">
                    <p className="text-sm text-slate-200 line-clamp-2">{news.title}</p>
                    <span className="text-xs text-slate-500 mt-1 block">{news.time}</span>
                  </div>
                ))}
              </div>
            </motion.div>

          </div>
        </div>
      </div>
    </main>
  );
}
