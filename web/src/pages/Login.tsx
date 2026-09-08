import { useState } from "react";
import { api, type User } from "../api.ts";
import { useAction } from "../hooks.ts";
import { Button, Field, Input, Notice, Wordmark } from "../ui.tsx";

export default function Login({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const action = useAction(async () => {
    onSignedIn(await api.login(email.trim(), password));
  });

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run();
        }}
        className="flex w-full max-w-sm flex-col gap-5 rounded-ctl bg-surface-raised p-6"
      >
        <div>
          <Wordmark className="text-2xl" />
          <p className="mt-1 text-sm text-content-muted">Sign in to manage upstreams, provider keys and consumer tokens.</p>
        </div>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {action.error ? <Notice kind="error">{action.error}</Notice> : null}
        <Button type="submit" variant="primary" busy={action.busy}>
          {action.busy ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
