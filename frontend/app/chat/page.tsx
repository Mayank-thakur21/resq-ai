"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Mic, MapPin, Activity, AlertTriangle, ShieldCheck, FileText, Phone, Volume2, VolumeX, Loader2 } from "lucide-react";
import axios from "axios";
import ReactMarkdown from "react-markdown";
import { motion, AnimatePresence } from "framer-motion";

type AIMetadata = {
  urgency_level?: string;
  detected_disaster?: string;
  advisory?: string;
  recommended_actions?: string[];
  emergency_numbers?: string[];
  steps_taken?: string[];
  data?: unknown;
};

type Message = {
  role: "user" | "ai";
  content: string;
  meta?: AIMetadata;
};

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "ai", content: "Hello! I am ResQ AI, your multi-agent emergency assistant. How can I help you today?" }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [speakResponse, setSpeakResponse] = useState(true);
  const [location, setLocation] = useState<{lat: number; lon: number} | null>(null);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loading]);

  const getLocation = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setLocation({
            lat: position.coords.latitude,
            lon: position.coords.longitude
          });
          alert("Location captured securely for emergencies.");
        },
        () => {
          alert("Unable to retrieve location.");
        }
      );
    }
  };

  const startVoice = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Your browser does not support the Web Speech API.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    setIsRecording(true);
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setInput(transcript);
      setIsRecording(false);
    };
    recognition.onerror = () => setIsRecording(false);
    recognition.onend = () => setIsRecording(false);
    recognition.start();
  };

  const speak = (text: string) => {
    if (!speakResponse || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
  };

  const handleSend = async () => {
    if (!input.trim()) return;
    const userMsg = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);

    try {
      const payload: Record<string, unknown> = { message: userMsg, language: "en" };
      if (location) {
        payload.location = location;
      }
      const res = await axios.post(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/chat`, payload);
      
      const reply = res.data;
      setMessages(prev => [...prev, { 
        role: "ai", 
        content: reply.response,
        meta: {
          urgency_level: reply.urgency_level,
          detected_disaster: reply.detected_disaster,
          advisory: reply.advisory,
          recommended_actions: reply.recommended_actions,
          emergency_numbers: reply.emergency_numbers,
          steps_taken: reply.steps_taken,
          data: reply.data
        }
      }]);
      
      speak(reply.response);
      
    } catch {
      setMessages(prev => [...prev, { role: "ai", content: "Error connecting to ResQ AI backend." }]);
    }
    setLoading(false);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-80px)] w-full max-w-5xl mx-auto bg-slate-50/50 dark:bg-slate-900/50">
      
      {/* Header */}
      <div className="bg-white/80 dark:bg-slate-950/80 backdrop-blur-md border-b px-6 py-4 flex justify-between items-center sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="bg-red-500/10 p-2 rounded-lg text-red-500">
            <Activity className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-900 to-slate-500 dark:from-white dark:to-slate-400">
              Emergency Assistant
            </h2>
            <p className="text-xs text-muted-foreground">Multi-Agent AI Network Online</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => setSpeakResponse(!speakResponse)} title="Toggle TTS">
            {speakResponse ? <Volume2 className="h-5 w-5 text-green-600" /> : <VolumeX className="h-5 w-5 text-slate-400" />}
          </Button>
        </div>
      </div>
      
      {/* Chat Area */}
      <ScrollArea className="flex-1 p-4 md:p-6">
        <div className="flex flex-col space-y-8 max-w-3xl mx-auto">
          <AnimatePresence>
            {messages.map((msg, i) => (
              <motion.div 
                key={i} 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div className={`max-w-[90%] md:max-w-[80%] flex flex-col gap-2 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                  
                  {/* User Bubble */}
                  {msg.role === "user" && (
                    <div className="bg-blue-600 text-white p-4 rounded-2xl rounded-tr-sm shadow-sm">
                      {msg.content}
                    </div>
                  )}

                  {/* AI Response Container */}
                  {msg.role === "ai" && (
                    <div className="w-full space-y-4">
                      
                      {/* Thinking Steps */}
                      {msg.meta?.steps_taken && (
                        <div className="bg-slate-100 dark:bg-slate-800/50 rounded-xl p-4 border text-xs text-slate-500 dark:text-slate-400 font-mono">
                          <div className="flex items-center gap-2 mb-2 font-semibold text-slate-700 dark:text-slate-300">
                            <Activity className="h-4 w-4" /> Agent Trace
                          </div>
                          <ul className="space-y-1">
                            {msg.meta.steps_taken.map((step, idx) => (
                              <motion.li 
                                initial={{ opacity: 0, x: -10 }} 
                                animate={{ opacity: 1, x: 0 }} 
                                transition={{ delay: idx * 0.15 }}
                                key={idx} 
                                className="flex items-center gap-2"
                              >
                                <span className="text-green-500">✔</span> {step}
                              </motion.li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Main AI Bubble */}
                      <div className="bg-white dark:bg-slate-900 border p-4 rounded-2xl rounded-tl-sm shadow-sm">
                        
                        {/* Structured Metadata Badges */}
                        {msg.meta && (
                          <div className="flex flex-wrap gap-2 mb-4 pb-4 border-b">
                            {msg.meta.detected_disaster && msg.meta.detected_disaster !== "unknown" && (
                              <span className="inline-flex items-center gap-1 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 px-2.5 py-1 rounded-full text-xs font-semibold uppercase tracking-wider">
                                <AlertTriangle className="h-3 w-3" /> {msg.meta.detected_disaster}
                              </span>
                            )}
                            {msg.meta.urgency_level && (
                              <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold uppercase tracking-wider
                                ${msg.meta.urgency_level === 'high' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' : 
                                  msg.meta.urgency_level === 'medium' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' : 
                                  'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'}`}>
                                Urgency: {msg.meta.urgency_level}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Content */}
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>

                        {/* Additional Info Cards */}
                        {msg.meta && (
                          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-3">
                            
                            {/* Recommended Actions */}
                            {msg.meta.recommended_actions && msg.meta.recommended_actions.length > 0 && (
                              <div className="bg-blue-50 dark:bg-blue-900/10 p-3 rounded-lg border border-blue-100 dark:border-blue-900/30">
                                <h4 className="flex items-center gap-2 text-sm font-semibold text-blue-700 dark:text-blue-400 mb-2">
                                  <ShieldCheck className="h-4 w-4" /> Actions
                                </h4>
                                <ul className="text-xs space-y-1 text-slate-700 dark:text-slate-300 list-disc list-inside">
                                  {msg.meta.recommended_actions.map((act, i) => <li key={i}>{act}</li>)}
                                </ul>
                              </div>
                            )}

                            {/* Emergency Numbers */}
                            {msg.meta.emergency_numbers && msg.meta.emergency_numbers.length > 0 && (
                              <div className="bg-red-50 dark:bg-red-900/10 p-3 rounded-lg border border-red-100 dark:border-red-900/30">
                                <h4 className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-400 mb-2">
                                  <Phone className="h-4 w-4" /> Contacts
                                </h4>
                                <ul className="text-xs space-y-1 text-slate-700 dark:text-slate-300">
                                  {msg.meta.emergency_numbers.map((num, i) => <li key={i} className="font-mono bg-white dark:bg-slate-800 px-2 py-1 rounded inline-block mr-2 mb-1 border">{num}</li>)}
                                </ul>
                              </div>
                            )}

                            {/* Advisories */}
                            {msg.meta.advisory && (
                              <div className="bg-amber-50 dark:bg-amber-900/10 p-3 rounded-lg border border-amber-100 dark:border-amber-900/30 md:col-span-2">
                                <h4 className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400 mb-1">
                                  <FileText className="h-4 w-4" /> Government Advisory
                                </h4>
                                <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">{msg.meta.advisory}</p>
                              </div>
                            )}

                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Loading Indicator */}
          {loading && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
              <div className="bg-white dark:bg-slate-900 border p-4 rounded-2xl rounded-tl-sm shadow-sm flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
                <span className="text-sm text-slate-500 animate-pulse">Agents analyzing request...</span>
              </div>
            </motion.div>
          )}
          <div ref={scrollRef} className="h-4" />
        </div>
      </ScrollArea>

      {/* Input Area */}
      <div className="p-4 bg-white dark:bg-slate-950 border-t">
        <div className="max-w-3xl mx-auto flex items-center gap-2">
          <Button 
            variant={location ? "default" : "outline"} 
            size="icon" 
            onClick={getLocation} 
            title="Share Location"
            className={location ? "bg-green-600 hover:bg-green-700 text-white" : ""}
          >
            <MapPin className="h-5 w-5" />
          </Button>
          
          <div className="relative flex-1">
            <Input 
              value={input} 
              onChange={(e) => setInput(e.target.value)} 
              placeholder="Describe your situation..."
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              disabled={loading}
              className="pr-12 py-6 rounded-full bg-slate-100 dark:bg-slate-900 border-transparent focus-visible:ring-blue-500 focus-visible:border-transparent text-base"
            />
            {isRecording && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <span className="w-1.5 h-4 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-6 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-4 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            )}
          </div>

          <Button 
            variant={isRecording ? "destructive" : "outline"} 
            size="icon" 
            onClick={startVoice} 
            className="rounded-full h-12 w-12"
          >
            <Mic className="h-5 w-5" />
          </Button>
          
          <Button 
            onClick={handleSend} 
            disabled={loading || !input.trim()}
            className="rounded-full h-12 w-12 bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Send className="h-5 w-5 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
