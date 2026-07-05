export default function PrivacyPage() {
  return (
    <div className="container mx-auto px-4 py-16 max-w-3xl">
      <h1 className="text-4xl font-bold mb-6 tracking-tight">Privacy Policy</h1>
      <div className="prose prose-lg dark:prose-invert">
        <p>
          At ResQ AI, your privacy and safety are our top priorities. 
          We do not store your location data permanently.
        </p>
        <p>
          Location data is only used temporarily to fetch nearby hospitals, shelters, 
          and weather advisories during your active session.
        </p>
      </div>
    </div>
  );
}
