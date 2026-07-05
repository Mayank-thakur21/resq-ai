"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneCall, AlertTriangle, ShieldCheck, Share2, Copy, Trash2, Plus, MessageCircle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type Contact = { name: string; phone: string; custom?: boolean };

const DEFAULT_CONTACTS: Contact[] = [
  { name: "National Emergency", phone: "112" },
  { name: "Ambulance", phone: "108" },
  { name: "Police", phone: "100" },
  { name: "Fire", phone: "101" }
];

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>(DEFAULT_CONTACTS);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [locationStr, setLocationStr] = useState<string>("");

  useEffect(() => {
    const saved = localStorage.getItem("resq_contacts");
    if (saved) {
      try {
        setContacts([...DEFAULT_CONTACTS, ...JSON.parse(saved)]);
      } catch {
        // ignore error
      }
    }
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => setLocationStr(`https://maps.google.com/?q=${pos.coords.latitude},${pos.coords.longitude}`)
      );
    }
  }, []);

  const saveCustomContacts = (newContacts: Contact[]) => {
    const custom = newContacts.filter(c => c.custom);
    localStorage.setItem("resq_contacts", JSON.stringify(custom));
    setContacts(newContacts);
  };

  const addContact = () => {
    if (newName && newPhone) {
      const updated = [...contacts, { name: newName, phone: newPhone, custom: true }];
      saveCustomContacts(updated);
      setNewName("");
      setNewPhone("");
    }
  };

  const removeContact = (index: number) => {
    const updated = contacts.filter((_, i) => i !== index);
    saveCustomContacts(updated);
  };

  const generateMessage = (type: "safe" | "help") => {
    const base = type === "safe" 
      ? "I am safe and currently out of danger." 
      : "EMERGENCY: I need help immediately!";
    const loc = locationStr ? ` My last known location is: ${locationStr}` : "";
    return `${base}${loc} (Sent via ResQ AI)`;
  };

  const handleShare = async (type: "safe" | "help") => {
    const text = generateMessage(type);
    if (navigator.share) {
      try {
        await navigator.share({ title: 'ResQ SOS', text });
      } catch {
        // ignore
      }
    } else {
      handleCopy(type);
    }
  };

  const handleCopy = (type: "safe" | "help") => {
    const text = generateMessage(type);
    navigator.clipboard.writeText(text);
    alert("Message copied to clipboard!");
  };

  const openWhatsApp = (type: "safe" | "help") => {
    const text = encodeURIComponent(generateMessage(type));
    window.open(`https://wa.me/?text=${text}`, "_blank");
  };

  return (
    <div className="flex flex-col min-h-[calc(100vh-80px)] p-4 md:p-8 bg-slate-50 dark:bg-slate-900">
      <div className="max-w-3xl mx-auto w-full space-y-8">
        
        <div className="text-center space-y-4">
          <div className="inline-flex items-center justify-center p-4 bg-purple-100 dark:bg-purple-900/30 rounded-full mb-4">
            <PhoneCall className="h-10 w-10 text-purple-600 dark:text-purple-400" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-slate-900 dark:text-white">SOS & Contacts</h1>
          <p className="text-lg text-slate-500 max-w-2xl mx-auto">
            Manage your trusted contacts and send instant location-aware SOS messages when connectivity is limited.
          </p>
        </div>

        {/* SOS Action Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="bg-white dark:bg-slate-950 p-6 rounded-3xl shadow-sm border-2 border-green-500/30 hover:border-green-500 transition-colors">
            <div className="flex items-center gap-3 mb-4">
              <div className="bg-green-100 dark:bg-green-900/50 p-3 rounded-full">
                <ShieldCheck className="h-6 w-6 text-green-600 dark:text-green-400" />
              </div>
              <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">I&apos;m Safe</h3>
            </div>
            <p className="text-sm text-slate-500 mb-6">Let your family know you are secure and out of harm&apos;s way.</p>
            <div className="flex gap-2">
              <Button onClick={() => handleShare("safe")} className="flex-1 bg-green-600 hover:bg-green-700 text-white"><Share2 className="mr-2 h-4 w-4" /> Share</Button>
              <Button onClick={() => openWhatsApp("safe")} variant="outline" size="icon" className="border-green-200 text-green-700 hover:bg-green-50"><MessageCircle className="h-4 w-4" /></Button>
              <Button onClick={() => handleCopy("safe")} variant="outline" size="icon"><Copy className="h-4 w-4" /></Button>
            </div>
          </motion.div>

          <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="bg-white dark:bg-slate-950 p-6 rounded-3xl shadow-sm border-2 border-red-500/30 hover:border-red-500 transition-colors">
            <div className="flex items-center gap-3 mb-4">
              <div className="bg-red-100 dark:bg-red-900/50 p-3 rounded-full">
                <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
              </div>
              <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">I Need Help</h3>
            </div>
            <p className="text-sm text-slate-500 mb-6">Broadcast an emergency distress signal with your last known location.</p>
            <div className="flex gap-2">
              <Button onClick={() => handleShare("help")} className="flex-1 bg-red-600 hover:bg-red-700 text-white"><Share2 className="mr-2 h-4 w-4" /> Share</Button>
              <Button onClick={() => openWhatsApp("help")} variant="outline" size="icon" className="border-red-200 text-red-700 hover:bg-red-50"><MessageCircle className="h-4 w-4" /></Button>
              <Button onClick={() => handleCopy("help")} variant="outline" size="icon"><Copy className="h-4 w-4" /></Button>
            </div>
          </motion.div>
        </div>

        {/* Contact List */}
        <div className="bg-white dark:bg-slate-950 p-6 md:p-8 rounded-3xl shadow-sm border border-slate-200 dark:border-slate-800">
          <h2 className="text-2xl font-bold mb-6 text-slate-800 dark:text-slate-100">Trusted Contacts</h2>
          
          <div className="flex flex-col sm:flex-row gap-3 mb-8">
            <Input placeholder="Name (e.g. Mom)" value={newName} onChange={(e) => setNewName(e.target.value)} className="bg-slate-50 dark:bg-slate-900 h-12 rounded-xl" />
            <Input placeholder="Phone Number" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} className="bg-slate-50 dark:bg-slate-900 h-12 rounded-xl" />
            <Button onClick={addContact} disabled={!newName || !newPhone} className="bg-purple-600 hover:bg-purple-700 h-12 rounded-xl px-8">
              <Plus className="mr-2 h-4 w-4" /> Add
            </Button>
          </div>

          <div className="space-y-3">
            <AnimatePresence>
              {contacts.map((contact, i) => (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -10 }}
                  key={i} 
                  className="flex justify-between items-center p-4 bg-slate-50 dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800"
                >
                  <div className="flex flex-col">
                    <span className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                      {contact.name}
                      {!contact.custom && <span className="text-[10px] uppercase tracking-wider bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 px-2 py-0.5 rounded-full">Default</span>}
                    </span>
                    <span className="text-sm font-mono text-slate-500 mt-1">{contact.phone}</span>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="icon" className="rounded-full bg-white dark:bg-slate-800 hover:text-green-600" onClick={() => window.location.href = `tel:${contact.phone}`}>
                      <PhoneCall className="h-4 w-4" />
                    </Button>
                    {contact.custom && (
                      <Button variant="outline" size="icon" onClick={() => removeContact(i)} className="rounded-full bg-white dark:bg-slate-800 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 border-transparent hover:border-red-200">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
