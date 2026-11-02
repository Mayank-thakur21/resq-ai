"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Bell,
  ChevronDown,
  House,
  Info,
  ListChecks,
  LogIn,
  LogOut,
  type LucideIcon,
  Map as MapIcon,
  Menu,
  MessageSquare,
  PhoneCall,
  ShieldAlert,
  Siren,
  TriangleAlert,
  User,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import * as React from "react";

import { signOutAndForget } from "@/lib/sign-out";
import { cn } from "@/lib/utils";

/**
 * Global navigation.
 *
 * - `lg` and up: sticky top bar with all links, an emphasised SOS link and the account menu.
 * - Below `lg`: compact top bar (logo, account, "More") plus a fixed bottom tab bar
 *   (Home, Map, SOS, Alerts, Chat). The tab bar is `h-16` + the iOS safe-area inset; the root
 *   layout pads the page bottom by the same amount (`pb-[calc(4rem+env(safe-area-inset-bottom))]`).
 */

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const PRIMARY_LINKS: NavItem[] = [
  { href: "/", label: "Home", icon: House },
  { href: "/map", label: "Map", icon: MapIcon },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/incidents", label: "Incidents", icon: TriangleAlert },
  { href: "/checklist", label: "Checklist", icon: ListChecks },
  { href: "/contacts", label: "Contacts", icon: PhoneCall },
];

const TAB_LINKS_LEFT: NavItem[] = [
  { href: "/", label: "Home", icon: House },
  { href: "/map", label: "Map", icon: MapIcon },
];
const TAB_LINKS_RIGHT: NavItem[] = [
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/chat", label: "Chat", icon: MessageSquare },
];

/** Links that only live in the mobile "More" sheet (not in the bottom tab bar). */
const MORE_LINKS: NavItem[] = [
  { href: "/incidents", label: "Incidents", icon: TriangleAlert },
  { href: "/checklist", label: "Checklist", icon: ListChecks },
  { href: "/contacts", label: "Contacts", icon: PhoneCall },
  { href: "/about", label: "About", icon: Info },
];

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950";

export function isActivePath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** `/login` link that brings the user back to the current page (except auth pages). */
export function loginHref(pathname: string | null): string {
  if (!pathname || pathname === "/" || pathname === "/login" || pathname === "/register") {
    return "/login";
  }
  return `/login?callbackUrl=${encodeURIComponent(pathname)}`;
}

function initials(name?: string | null, email?: string | null): string {
  const source = (name || email || "?").trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/"
      className={cn("flex items-center gap-2 rounded-lg", focusRing)}
      aria-label="ResQ AI home"
    >
      <span className="inline-flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-red-500 to-red-700 shadow-lg shadow-red-900/40">
        <ShieldAlert aria-hidden="true" className="size-5 text-white" />
      </span>
      <span
        className={cn(
          "bg-gradient-to-r from-blue-400 via-cyan-300 to-emerald-400 bg-clip-text font-extrabold tracking-tight text-transparent",
          compact ? "text-lg" : "text-xl",
        )}
      >
        ResQ AI
      </span>
    </Link>
  );
}

/** Closes a popover/sheet on Escape and on clicks outside `ref`. */
function useDismiss(
  open: boolean,
  close: () => void,
  ref: React.RefObject<HTMLElement | null>,
  { outsideClick = true }: { outsideClick?: boolean } = {},
) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    if (outsideClick) document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close, ref, outsideClick]);
}

function AccountMenu() {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuId = React.useId();

  const close = React.useCallback(() => setOpen(false), []);
  useDismiss(open, close, containerRef);

  // Close the menu after navigating.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  if (status === "loading") {
    return <span aria-hidden="true" className="h-9 w-24 animate-pulse rounded-full bg-slate-800" />;
  }

  if (!session?.user) {
    return (
      <Link
        href={loginHref(pathname)}
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-800/70 hover:text-white",
          focusRing,
        )}
      >
        <LogIn aria-hidden="true" className="size-4" />
        Sign in
      </Link>
    );
  }

  const { name, email } = session.user;
  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Account menu for ${name || email || "your account"}`}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/60 py-1 pr-3 pl-1 text-sm text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-800",
          focusRing,
        )}
      >
        <span
          aria-hidden="true"
          className="inline-flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 text-xs font-bold text-white"
        >
          {initials(name, email)}
        </span>
        <span className="max-w-[10rem] truncate">{name || email}</span>
        <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div
          id={menuId}
          className="absolute right-0 mt-2 w-56 overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 p-1 shadow-2xl shadow-black/50 backdrop-blur-md"
        >
          <div className="border-b border-slate-800 px-3 py-2">
            <p className="truncate text-sm font-semibold text-white">{name || "Signed in"}</p>
            {email && <p className="truncate text-xs text-slate-400">{email}</p>}
          </div>
          <Link
            href="/profile"
            onClick={close}
            className={cn(
              "mt-1 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 hover:text-white",
              focusRing,
            )}
          >
            <User aria-hidden="true" className="size-4" />
            Profile
          </Link>
          <button
            type="button"
            onClick={() => {
              close();
              void signOutAndForget("/").catch((error: unknown) => {
                console.error("[navbar] sign out failed", error);
              });
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800 hover:text-white",
              focusRing,
            )}
          >
            <LogOut aria-hidden="true" className="size-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const reduceMotion = useReducedMotion();

  useDismiss(open, onClose, panelRef, { outsideClick: false });

  // Lock page scroll and move focus into the sheet while it is open.
  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>("a, button");
    firstFocusable?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // Simple focus trap: keep Tab inside the sheet.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusables = Array.from(panelRef.current.querySelectorAll<HTMLElement>("a, button"));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const itemClass = (active: boolean) =>
    cn(
      "flex items-center gap-3 rounded-xl px-4 py-3 text-base transition-colors",
      active ? "bg-slate-800 text-white" : "text-slate-200 hover:bg-slate-800/70",
      focusRing,
    );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="more-sheet"
          className="fixed inset-0 z-50 lg:hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
        >
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            className="absolute inset-0 h-full w-full cursor-default bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onKeyDown={onKeyDown}
            className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-3xl border-t border-slate-700 bg-slate-900 px-4 pt-3 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-2xl"
            initial={reduceMotion ? false : { y: "100%" }}
            animate={{ y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 320 }}
          >
            <div aria-hidden="true" className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-slate-700" />
            <div className="mb-2 flex items-center justify-between px-1">
              <h2 id={titleId} className="text-lg font-semibold text-white">
                More
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close menu"
                className={cn("rounded-full p-2 text-slate-300 hover:bg-slate-800 hover:text-white", focusRing)}
              >
                <X aria-hidden="true" className="size-5" />
              </button>
            </div>
            <nav aria-label="More pages">
              <ul className="space-y-1">
                {MORE_LINKS.map(({ href, label, icon: Icon }) => {
                  const active = isActivePath(pathname, href);
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        onClick={onClose}
                        aria-current={active ? "page" : undefined}
                        className={itemClass(active)}
                      >
                        <Icon aria-hidden="true" className="size-5 text-slate-400" />
                        {label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-3 border-t border-slate-800 pt-3">
                {status === "authenticated" && session?.user ? (
                  <ul className="space-y-1">
                    <li>
                      <Link
                        href="/profile"
                        onClick={onClose}
                        aria-current={isActivePath(pathname, "/profile") ? "page" : undefined}
                        className={itemClass(isActivePath(pathname, "/profile"))}
                      >
                        <User aria-hidden="true" className="size-5 text-slate-400" />
                        <span className="min-w-0 flex-1 truncate">
                          Profile
                          <span className="block truncate text-xs text-slate-400">
                            {session.user.name || session.user.email}
                          </span>
                        </span>
                      </Link>
                    </li>
                    <li>
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          void signOutAndForget("/").catch((error: unknown) => {
                            console.error("[navbar] sign out failed", error);
                          });
                        }}
                        className={cn(itemClass(false), "w-full text-left")}
                      >
                        <LogOut aria-hidden="true" className="size-5 text-slate-400" />
                        Sign out
                      </button>
                    </li>
                  </ul>
                ) : (
                  <Link
                    href={loginHref(pathname)}
                    onClick={onClose}
                    className={itemClass(false)}
                  >
                    <LogIn aria-hidden="true" className="size-5 text-slate-400" />
                    Sign in
                  </Link>
                )}
              </div>
            </nav>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TabLink({ item, pathname }: { item: NavItem; pathname: string | null }) {
  const active = isActivePath(pathname, item.href);
  const Icon = item.icon;
  return (
    <li className="flex">
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl py-1 text-[11px] font-medium transition-colors",
          active ? "text-white" : "text-slate-400 hover:text-slate-200",
          focusRing,
        )}
      >
        <Icon aria-hidden="true" className={cn("size-5", active && "text-cyan-300")} />
        {item.label}
      </Link>
    </li>
  );
}

export default function Navbar() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const moreButtonRef = React.useRef<HTMLButtonElement>(null);
  const sosActive = isActivePath(pathname, "/sos");

  const closeMore = React.useCallback(() => {
    setMoreOpen(false);
    // Return focus to the trigger for keyboard and screen-reader users.
    moreButtonRef.current?.focus();
  }, []);

  React.useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/80 text-white backdrop-blur-md supports-[backdrop-filter]:bg-slate-950/65">
        {/* Desktop */}
        <div className="mx-auto hidden h-16 max-w-7xl items-center gap-6 px-6 lg:flex">
          <Logo />
          <nav aria-label="Main" className="flex-1">
            <ul className="flex items-center gap-1">
              {PRIMARY_LINKS.map(({ href, label }) => {
                const active = isActivePath(pathname, href);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        active
                          ? "bg-slate-800/80 text-white"
                          : "text-slate-300 hover:bg-slate-800/50 hover:text-white",
                        focusRing,
                      )}
                    >
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <Link
            href="/sos"
            aria-current={sosActive ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-full bg-red-600 px-5 py-2 text-sm font-bold tracking-wide text-white shadow-lg shadow-red-900/40 transition-colors hover:bg-red-500",
              sosActive && "ring-2 ring-red-300",
              focusRing,
            )}
          >
            <Siren aria-hidden="true" className="size-4" />
            SOS
          </Link>
          <AccountMenu />
        </div>

        {/* Mobile / tablet */}
        <div className="flex h-14 items-center justify-between gap-3 px-4 lg:hidden">
          <Logo compact />
          <div className="flex items-center gap-2">
            <AccountMenuCompact />
            <button
              ref={moreButtonRef}
              type="button"
              aria-label="More pages"
              aria-expanded={moreOpen}
              aria-haspopup="dialog"
              onClick={() => setMoreOpen(true)}
              className={cn(
                "rounded-full p-2 text-slate-200 transition-colors hover:bg-slate-800 hover:text-white",
                focusRing,
              )}
            >
              <Menu aria-hidden="true" className="size-6" />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile bottom tab bar */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-slate-950/90 pb-[env(safe-area-inset-bottom)] text-white backdrop-blur-md lg:hidden"
      >
        <ul className="mx-auto grid h-16 max-w-lg grid-cols-5 items-stretch px-2">
          {TAB_LINKS_LEFT.map((item) => (
            <TabLink key={item.href} item={item} pathname={pathname} />
          ))}
          <li className="flex items-start justify-center">
            <Link
              href="/sos"
              aria-label="SOS emergency"
              aria-current={sosActive ? "page" : undefined}
              className={cn(
                "-mt-5 flex size-16 flex-col items-center justify-center rounded-full border-4 border-slate-950 bg-red-600 text-xs font-extrabold tracking-wider text-white shadow-xl shadow-red-900/50 transition-colors hover:bg-red-500 active:scale-95 motion-reduce:transition-none",
                sosActive && "ring-2 ring-red-300",
                focusRing,
              )}
            >
              <Siren aria-hidden="true" className="size-6" />
              SOS
            </Link>
          </li>
          {TAB_LINKS_RIGHT.map((item) => (
            <TabLink key={item.href} item={item} pathname={pathname} />
          ))}
        </ul>
      </nav>

      <MoreSheet open={moreOpen} onClose={closeMore} />
    </>
  );
}

/** Mobile top-bar account control: avatar link to /profile, or a "Sign in" link. */
function AccountMenuCompact() {
  const { data: session, status } = useSession();
  const pathname = usePathname();

  if (status === "loading") {
    return <span aria-hidden="true" className="size-8 animate-pulse rounded-full bg-slate-800" />;
  }
  if (!session?.user) {
    return (
      <Link
        href={loginHref(pathname)}
        className={cn(
          "rounded-full border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-800",
          focusRing,
        )}
      >
        Sign in
      </Link>
    );
  }
  return (
    <Link
      href="/profile"
      aria-label={`Profile of ${session.user.name || session.user.email || "your account"}`}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 text-xs font-bold text-white",
        focusRing,
      )}
    >
      {initials(session.user.name, session.user.email)}
    </Link>
  );
}
