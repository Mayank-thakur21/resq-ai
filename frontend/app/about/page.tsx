export default function AboutPage() {
  return (
    <div className="container mx-auto px-4 py-16 max-w-3xl">
      <h1 className="text-4xl font-bold mb-6 tracking-tight">About ResQ AI</h1>
      <div className="prose prose-lg dark:prose-invert">
        <p>
          ResQ AI is an intelligent disaster response assistant designed to provide 
          real-time, actionable, and life-saving information during emergencies.
        </p>
        <p>
          Built with cutting-edge AI and open data (OpenStreetMap, Open-Meteo), 
          our goal is to make emergency preparedness and response accessible to everyone, everywhere.
        </p>
      </div>
    </div>
  );
}
