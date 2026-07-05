import Link from 'next/link';
import { Heart } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="w-full border-t bg-background/80 backdrop-blur-md">
      <div className="container mx-auto px-4 py-8 flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="flex flex-col items-center md:items-start">
          <Link href="/" className="flex items-center gap-2">
            <Heart className="h-6 w-6 text-red-500" />
            <span className="text-xl font-bold tracking-tight">ResQ AI</span>
          </Link>
          <p className="text-sm text-muted-foreground mt-2">
            Your intelligent disaster response assistant.
          </p>
        </div>
        
        <div className="flex gap-6 text-sm font-medium">
          <Link href="/about" className="hover:text-primary transition-colors">About</Link>
          <Link href="/contact" className="hover:text-primary transition-colors">Contact</Link>
          <Link href="/privacy" className="hover:text-primary transition-colors">Privacy</Link>
        </div>
        
        <div className="text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} ResQ AI. Built for impact.
        </div>
      </div>
    </footer>
  );
}
