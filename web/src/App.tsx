import { Activity, Code, Community, Computer, HalfMoon, IconoirProvider, Key, List, LogOut, Server, SidebarCollapse, SidebarExpand, SunLight, Terminal } from "iconoir-react";
import { useEffect, useState } from "react";
import { Link, Route, Router, Switch, useLocation } from "wouter";
import { api, onUnauthenticated, type User } from "./api.ts";
import ApiKeys from "./pages/ApiKeys.tsx";
import Login from "./pages/Login.tsx";
import Overview from "./pages/Overview.tsx";
import { NewPolicyPage, PoliciesPage, PolicyPage } from "./pages/Policies.tsx";
import Requests from "./pages/Requests.tsx";
import { EditTokenPage, NewTokenPage, TokensPage } from "./pages/Tokens.tsx";
import UpstreamDetail from "./pages/UpstreamDetail.tsx";
import { NewUpstreamPage, UpstreamsPage } from "./pages/Upstreams.tsx";
import Users from "./pages/Users.tsx";
import { SessionContext } from "./session.ts";
import { useSidebar } from "./sidebar.ts";
import { THEMES, useTheme, type Theme } from "./theme.ts";
import { Button, TextLink, Wordmark } from "./ui.tsx";

const MARK_SRC = `${import.meta.env.BASE_URL}favicon.svg`;

const NAV: { href: string; label: string; icon: typeof Activity }[] = [
  { href: "/", label: "Overview", icon: Activity },
  { href: "/upstreams", label: "Upstreams", icon: Server },
  { href: "/tokens", label: "Tokens", icon: Key },
  { href: "/policies", label: "Policies", icon: Code },
  { href: "/requests", label: "Requests", icon: List },
  { href: "/users", label: "Users", icon: Community },
  { href: "/api-keys", label: "API keys", icon: Terminal },
];

const THEME_LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };
const THEME_ICON: Record<Theme, typeof SunLight> = { system: Computer, light: SunLight, dark: HalfMoon };

function NavLink({ href, label, icon: Icon, collapsed }: { href: string; label: string; icon: typeof Activity; collapsed: boolean }) {
  const [location] = useLocation();
  const active = href === "/" ? location === "/" : location.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={`flex items-center gap-2.5 rounded-ctl px-2.5 py-1.5 text-sm whitespace-nowrap ${
        active ? "bg-surface-raised font-medium text-content-default" : "text-content-muted transition-colors duration-[120ms] hover:bg-surface-raised hover:text-content-default"
      }`}
    >
      <Icon aria-hidden className="shrink-0" />
      <span className={collapsed ? "md:hidden" : ""}>{label}</span>
    </Link>
  );
}

function ThemeControl({ collapsed }: { collapsed: boolean }) {
  const [theme, setTheme] = useTheme();
  const Icon = THEME_ICON[theme];
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? "system";
  const label = `Theme: ${THEME_LABEL[theme]}, click for ${THEME_LABEL[next]}`;
  return (
    <Button variant="quiet" size="sm" className={collapsed ? "" : "-ml-2.5 self-start"} onClick={() => setTheme(next)} aria-label={label} title={label}>
      <Icon aria-hidden />
      <span className={collapsed ? "md:hidden" : ""}>{THEME_LABEL[theme]}</span>
    </Button>
  );
}

function Shell({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [signingOut, setSigningOut] = useState(false);
  const [collapsed, toggleSidebar] = useSidebar();
  const signOut = (): void => {
    setSigningOut(true);
    api.logout().finally(onSignOut);
  };
  const hideWhenCollapsed = collapsed ? "md:hidden" : "";
  return (
    <SessionContext value={user}>
      <div className="min-h-screen md:grid md:grid-cols-[auto_minmax(0,1fr)]">
        <aside className="sidebar flex flex-col gap-3 border-b border-border-subtle bg-surface-sunken px-3 py-3 md:sticky md:top-0 md:h-screen md:overflow-hidden md:border-r md:border-b-0 md:py-4">
          <div className={`flex items-center gap-2 ${collapsed ? "md:flex-col md:gap-3" : "justify-between"}`}>
            <Link href="/" className="flex min-w-0 items-center gap-2 px-1.5" aria-label="keygate overview">
              <img src={MARK_SRC} alt="" width={20} height={20} className="h-5 w-5 shrink-0" />
              <span className={`min-w-0 ${hideWhenCollapsed}`}>
                <Wordmark className="block text-lg leading-tight" />
              </span>
            </Link>
            <span className="hidden shrink-0 md:inline-flex">
              <Button
                variant="quiet"
                size="sm"
                onClick={toggleSidebar}
                aria-expanded={!collapsed}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                {collapsed ? <SidebarExpand aria-hidden /> : <SidebarCollapse aria-hidden />}
              </Button>
            </span>
          </div>
          <nav aria-label="Sections" className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
            {NAV.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} icon={item.icon} collapsed={collapsed} />
            ))}
          </nav>
          <div className="hidden flex-1 md:block" />
          <div className={`hidden md:flex md:flex-col md:gap-2 ${collapsed ? "md:items-center" : "md:px-1.5"}`}>
            <div className={hideWhenCollapsed}>
              <p className="truncate text-sm font-medium" title={user.name}>
                {user.name}
              </p>
              <p className="truncate text-xs text-content-muted" title={user.email}>
                {user.email}
              </p>
            </div>
            <ThemeControl collapsed={collapsed} />
            <Button
              variant="quiet"
              size="sm"
              className={collapsed ? "" : "-ml-2.5 self-start"}
              onClick={signOut}
              busy={signingOut}
              aria-label={collapsed ? "Sign out" : undefined}
              title={collapsed ? `Sign out ${user.email}` : undefined}
            >
              <LogOut aria-hidden />
              <span className={hideWhenCollapsed}>Sign out</span>
            </Button>
          </div>
        </aside>
        <main className="min-w-0 px-4 py-5 md:px-8 md:py-7">
          <div className="mx-auto max-w-[1200px]">
            <Switch>
              <Route path="/" component={Overview} />
              <Route path="/upstreams" component={UpstreamsPage} />
              <Route path="/upstreams/new" component={NewUpstreamPage} />
              <Route path="/upstreams/:id">{(params) => <UpstreamDetail id={Number(params.id)} />}</Route>
              <Route path="/tokens" component={TokensPage} />
              <Route path="/tokens/new" component={NewTokenPage} />
              <Route path="/tokens/:id">{(params) => <EditTokenPage id={Number(params.id)} />}</Route>
              <Route path="/policies" component={PoliciesPage} />
              <Route path="/policies/new" component={NewPolicyPage} />
              <Route path="/policies/:id">{(params) => <PolicyPage id={Number(params.id)} />}</Route>
              <Route path="/requests" component={Requests} />
              <Route path="/users" component={Users} />
              <Route path="/api-keys" component={ApiKeys} />
              <Route>
                <NotFound />
              </Route>
            </Switch>
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-content-muted md:hidden">
            <span className="truncate">{user.email}</span>
            <span className="flex items-center gap-3">
              <ThemeControl collapsed={false} />
              <Button variant="quiet" size="sm" onClick={signOut} busy={signingOut}>
                <LogOut aria-hidden />
                Sign out
              </Button>
            </span>
          </div>
        </main>
      </div>
    </SessionContext>
  );
}

function NotFound() {
  return (
    <div className="py-12 text-sm text-content-muted">
      <p>No page at this address.</p>
      <p className="mt-2">
        <TextLink href="/">Go to the overview</TextLink>
      </p>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api.me().then(
      (u) => {
        if (live) setUser(u);
      },
      () => {
        if (live) setUser(null);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => onUnauthenticated(() => setUser(null)), []);

  if (user === undefined) return null;
  return (
    <IconoirProvider iconProps={{ width: 16, height: 16, strokeWidth: 1.5 }}>
      <Router base="/admin">{user ? <Shell user={user} onSignOut={() => setUser(null)} /> : <Login onSignedIn={setUser} />}</Router>
    </IconoirProvider>
  );
}
