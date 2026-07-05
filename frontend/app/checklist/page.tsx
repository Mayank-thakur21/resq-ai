"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListChecks, Printer, Download, Loader2 } from "lucide-react";
import axios from "axios";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { motion, AnimatePresence } from "framer-motion";

const PRESETS = ["Flood", "Earthquake", "Fire", "Cyclone", "Heatwave", "Landslide"];

export default function ChecklistPage() {
  const [disaster, setDisaster] = useState("");
  const [checklist, setChecklist] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [checkedItems, setCheckedItems] = useState<{[key: number]: boolean}>({});
  const listRef = useRef<HTMLDivElement>(null);

  const generateChecklist = async (type: string = disaster) => {
    if (!type.trim()) return;
    setDisaster(type);
    setLoading(true);
    try {
      const res = await axios.post(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/checklist`, { disaster_type: type, language: "en" });
      setChecklist(res.data.checklist || []);
      setCheckedItems({});
    } catch {
      alert("Error generating checklist.");
    }
    setLoading(false);
  };

  const toggleItem = (index: number) => {
    setCheckedItems(prev => ({ ...prev, [index]: !prev[index] }));
  };

  const handlePrint = () => {
    window.print();
  };

  const handleDownloadPdf = async () => {
    if (!listRef.current) return;
    const canvas = await html2canvas(listRef.current, { scale: 2 });
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF("p", "mm", "a4");
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
    
    pdf.setFontSize(22);
    pdf.text(`${disaster || 'Emergency'} Checklist`, 14, 20);
    pdf.addImage(imgData, "PNG", 10, 30, pdfWidth - 20, pdfHeight - 40);
    pdf.save(`resq-checklist-${disaster || 'emergency'}.pdf`);
  };

  return (
    <div className="flex flex-col min-h-[calc(100vh-80px)] p-4 md:p-8 bg-slate-50 dark:bg-slate-900">
      <div className="max-w-4xl mx-auto w-full space-y-8">
        
        <div className="text-center space-y-4">
          <div className="inline-flex items-center justify-center p-4 bg-emerald-100 dark:bg-emerald-900/30 rounded-full mb-4">
            <ListChecks className="h-10 w-10 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-slate-900 dark:text-white">Smart Checklists</h1>
          <p className="text-lg text-slate-500 max-w-2xl mx-auto">
            Generate AI-tailored emergency kits and preparedness steps. Keep track of what you have and what you need.
          </p>
        </div>

        {/* Input Area */}
        <div className="bg-white dark:bg-slate-950 p-6 rounded-3xl shadow-sm border border-slate-200 dark:border-slate-800">
          <div className="flex flex-col md:flex-row gap-4 mb-6">
            <Input 
              value={disaster} 
              onChange={(e) => setDisaster(e.target.value)} 
              placeholder="Enter disaster type (e.g. Flood, Earthquake)..."
              className="text-lg h-14 rounded-2xl bg-slate-50 dark:bg-slate-900"
              onKeyDown={(e) => e.key === "Enter" && generateChecklist()}
            />
            <Button 
              onClick={() => generateChecklist()} 
              disabled={loading || !disaster.trim()} 
              className="h-14 px-8 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white text-lg min-w-[160px]"
            >
              {loading ? <Loader2 className="animate-spin h-6 w-6" /> : "Generate"}
            </Button>
          </div>
          
          <div className="flex flex-wrap gap-2">
            <span className="text-sm font-medium text-slate-400 py-2 mr-2">Quick Select:</span>
            {PRESETS.map((preset) => (
              <Button 
                key={preset} 
                variant="outline" 
                size="sm"
                className="rounded-full"
                onClick={() => generateChecklist(preset)}
                disabled={loading}
              >
                {preset}
              </Button>
            ))}
          </div>
        </div>

        {/* Checklist Area */}
        <AnimatePresence>
          {checklist.length > 0 && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <div className="flex justify-between items-center bg-white dark:bg-slate-950 p-4 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 print:hidden">
                <div className="text-sm font-medium text-slate-500">
                  {Object.values(checkedItems).filter(Boolean).length} of {checklist.length} completed
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={handlePrint} className="gap-2">
                    <Printer className="h-4 w-4" /> Print
                  </Button>
                  <Button variant="outline" onClick={handleDownloadPdf} className="gap-2 border-emerald-200 hover:bg-emerald-50 dark:border-emerald-900 dark:hover:bg-emerald-900/30">
                    <Download className="h-4 w-4 text-emerald-600" /> PDF
                  </Button>
                </div>
              </div>

              <div ref={listRef} className="space-y-3 bg-white dark:bg-slate-950 p-6 md:p-8 rounded-3xl shadow-sm border border-slate-200 dark:border-slate-800">
                <h2 className="text-2xl font-bold mb-6 text-slate-800 dark:text-slate-100 hidden print:block">
                  {disaster} Emergency Checklist
                </h2>
                {checklist.map((item, i) => (
                  <motion.div 
                    initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.1 }}
                    key={i} 
                    className="flex items-center p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 cursor-pointer hover:border-emerald-400 transition-colors group" 
                    onClick={() => toggleItem(i)}
                  >
                    <div className={`flex-shrink-0 h-6 w-6 rounded-md border-2 mr-4 flex items-center justify-center transition-colors
                      ${checkedItems[i] ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 dark:border-slate-600 group-hover:border-emerald-400'}`}>
                      {checkedItems[i] && <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                    </div>
                    <span className={`text-lg transition-all ${checkedItems[i] ? 'line-through text-slate-400' : 'text-slate-800 dark:text-slate-200'}`}>
                      {item}
                    </span>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </div>
  );
}
