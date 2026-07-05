export default function ContactPage() {
  return (
    <div className="container mx-auto px-4 py-16 max-w-3xl">
      <h1 className="text-4xl font-bold mb-6 tracking-tight">Contact Us</h1>
      <p className="text-lg text-muted-foreground mb-8">
        For inquiries, partnerships, or support, please reach out to our team.
      </p>
      <div className="bg-card border rounded-xl p-8 shadow-sm">
        <p className="font-medium">Email: <a href="mailto:support@resq-ai.org" className="text-primary hover:underline">support@resq-ai.org</a></p>
        <p className="font-medium mt-2">Emergency? Please dial your local emergency numbers (e.g. 112, 911).</p>
      </div>
    </div>
  );
}
