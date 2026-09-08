import { useEffect, useState, type ReactNode } from "react";
import { Link, Route, Router, Switch, useLocation } from "wouter";
import { api, onUnauthenticated, type User } from "./api.ts";
import Login from "./pages/Login.tsx";
import Overview from "./pages/Overview.tsx";
import Requests from "./pages/Requests.tsx";
import { EditTokenPage, NewTokenPage, TokensPage } from "./pages/Tokens.tsx";
import UpstreamDetail from "./pages/UpstreamDetail.tsx";
import { NewUpstreamPage, UpstreamsPage } from "./pages/Upstreams.tsx";
import Users from "./pages/Users.tsx";
import { SessionContext } from "./session.ts";
import { Button, TextLink, Wordmark } from "./ui.tsx";

const NAV: { href: string; label: string }[] = [
  { href: "/", label: "Overview" },
  { href: "/upstreams", label: "Upstreams" },
  { href: "/tokens", label: "Tokens" },
  { href: "/requests", label: "Requests" },
  { href: "/users", label: "Users" },
];

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const [location] = useLocation();
  const active = href === "/" ? location === "/" : location.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-ctl bg-surface-raised px-3 py-1.5 text-sm font-medium text-content-default"
          : "rounded-ctl px-3 py-1.5 text-sm text-content-muted transition-colors duration-[120ms] hover:bg-surface-raised hover:text-content-default"
      }
    >
      {children}
    </Link>
  );
}

function Shell({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [signingOut, setSigningOut] = useState(false);
  const signOut = (): void => {
    setSigningOut(true);
    api.logout().finally(onSignOut);
  };
  return (
    <SessionContext value={user}>
      <div className="min-h-screen md:grid md:grid-cols-[13.5rem_minmax(0,1fr)]">
        <aside className="flex flex-col gap-3 border-b border-border-subtle bg-surface-sunken px-3 py-3 md:sticky md:top-0 md:h-screen md:border-r md:border-b-0 md:py-5">
          <div className="px-3">
            <Wordmark className="text-lg" />
            <p className="truncate font-mono text-xs text-content-muted" title={window.location.host}>
              {window.location.host}
            </p>
          </div>
          <nav aria-label="Sections" className="flex gap-1 overflow-x-auto md:flex-col">
            {NAV.map((item) => (
              <NavLink key={item.href} href={item.href}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="hidden flex-1 md:block" />
          <div className="hidden px-3 md:block">
            <p className="truncate text-sm font-medium" title={user.name}>
              {user.name}
            </p>
            <p className="truncate text-xs text-content-muted" title={user.email}>
              {user.email}
            </p>
            <Button variant="quiet" size="sm" className="-ml-2.5 mt-2" onClick={signOut} busy={signingOut}>
              Sign out
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
              <Route path="/requests" component={Requests} />
              <Route path="/users" component={Users} />
              <Route>
                <NotFound />
              </Route>
            </Switch>
          </div>
          <div className="mt-8 flex items-center justify-between gap-3 px-1 text-xs text-content-muted md:hidden">
            <span className="truncate">{user.email}</span>
            <Button variant="quiet" size="sm" onClick={signOut} busy={signingOut}>
              Sign out
            </Button>
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
  return <Router base="/admin">{user ? <Shell user={user} onSignOut={() => setUser(null)} /> : <Login onSignedIn={setUser} />}</Router>;
}
