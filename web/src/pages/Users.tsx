import { useState } from "react";
import { api, type User } from "../api.ts";
import { formatDate, formatDateTime } from "../format.ts";
import { useAction, useLoad } from "../hooks.ts";
import { useSession } from "../session.ts";
import { Button, ConfirmDialog, Field, Input, LoadError, Notice, PageHeader, Panel, Pill, TableMessage } from "../ui.tsx";

function AddUserForm({ onAdded }: { onAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const action = useAction(async () => {
    await api.users.create({ email: email.trim(), name: name.trim(), password });
    setEmail("");
    setName("");
    setPassword("");
    onAdded();
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (password.length < 8) {
          setPasswordError("Use at least 8 characters.");
          document.getElementById("new-password")?.focus();
          return;
        }
        setPasswordError(null);
        void action.run();
      }}
      className="grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-start"
    >
      <Field label="Name" htmlFor="new-name">
        <Input id="new-name" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Email" htmlFor="new-email">
        <Input id="new-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Password" htmlFor="new-password" hint="At least 8 characters." error={passwordError}>
        <Input
          id="new-password"
          type="password"
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (passwordError) setPasswordError(null);
          }}
          autoComplete="new-password"
          aria-invalid={passwordError ? true : undefined}
        />
      </Field>
      <div className="md:pt-7">
        <Button type="submit" variant="primary" busy={action.busy}>
          {action.busy ? "Adding..." : "Add user"}
        </Button>
      </div>
      {action.error ? (
        <div className="md:col-span-4">
          <Notice kind="error">{action.error}</Notice>
        </div>
      ) : null}
    </form>
  );
}

function PasswordRow({ user, onSaved, onCancel }: { user: User; onSaved: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const action = useAction(async () => {
    await api.users.setPassword(user.id, password);
    onSaved();
  });
  return (
    <tr>
      <td colSpan={4} className="bg-surface-sunken">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password.length < 8) {
              setError("Use at least 8 characters.");
              return;
            }
            setError(null);
            void action.run();
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <Field label={`New password for ${user.email}`} htmlFor={`pw-${user.id}`} error={error ?? action.error}>
            <Input
              id={`pw-${user.id}`}
              type="password"
              className="min-w-64"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
              autoFocus
            />
          </Field>
          <div className="flex gap-2 pb-px">
            <Button type="submit" variant="primary" busy={action.busy}>
              {action.busy ? "Saving..." : "Save password"}
            </Button>
            <Button variant="quiet" onClick={onCancel} disabled={action.busy}>
              Cancel
            </Button>
          </div>
        </form>
      </td>
    </tr>
  );
}

export default function Users() {
  const me = useSession();
  const load = useLoad("users", api.users.list);
  const [editing, setEditing] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const remove = useAction(async (id: number) => {
    await api.users.remove(id);
    setDeleting(null);
    load.reload();
  });
  const data = load.data;

  return (
    <>
      <PageHeader title="Users" description="Everyone who can sign in here. All users have the same rights." />
      {load.error ? <LoadError message={load.error} onRetry={load.reload} /> : null}
      {saved ? (
        <Notice
          kind="ok"
          className="mb-4"
          action={
            <Button size="sm" variant="quiet" onClick={() => setSaved(null)}>
              Dismiss
            </Button>
          }
        >
          {saved}
        </Notice>
      ) : null}
      <div className="flex flex-col gap-6">
        <Panel bleed>
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Added</th>
                <th className="actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data === null ? (
                <TableMessage colSpan={4}>{load.error ? "Nothing to show." : "Loading users..."}</TableMessage>
              ) : (
                data.map((u) => (
                  <UserRows
                    key={u.id}
                    user={u}
                    self={u.id === me.id}
                    editing={editing === u.id}
                    onEdit={() => setEditing(u.id)}
                    onSaved={() => {
                      setEditing(null);
                      setSaved(`Password for ${u.email} updated.`);
                    }}
                    onCancel={() => setEditing(null)}
                    onDelete={() => setDeleting(u)}
                  />
                ))
              )}
            </tbody>
          </table>
        </Panel>
        <Panel title="Add user">
          <AddUserForm
            onAdded={() => {
              setSaved("User added.");
              load.reload();
            }}
          />
        </Panel>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `Delete ${deleting.email}?` : ""}
        confirmLabel="Delete user"
        busy={remove.busy}
        error={remove.error}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}
        onConfirm={() => {
          if (deleting) void remove.run(deleting.id);
        }}
      >
        Their sessions end immediately. Upstreams, keys and tokens they created stay in place.
      </ConfirmDialog>
    </>
  );
}

interface UserRowsProps {
  user: User;
  self: boolean;
  editing: boolean;
  onEdit: () => void;
  onSaved: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

function UserRows({ user, self, editing, onEdit, onSaved, onCancel, onDelete }: UserRowsProps) {
  return (
    <>
      <tr>
        <td>
          <span className="inline-flex items-center gap-2">
            <span className="max-w-[24ch] truncate" title={user.name}>
              {user.name}
            </span>
            {self ? <Pill tone="accent">You</Pill> : null}
          </span>
        </td>
        <td>
          <span className="block max-w-[32ch] truncate" title={user.email}>
            {user.email}
          </span>
        </td>
        <td title={formatDateTime(user.created_at)}>{formatDate(user.created_at)}</td>
        <td className="actions">
          <span className="inline-flex gap-1">
            <Button size="sm" variant="quiet" onClick={onEdit} disabled={editing}>
              Set password
            </Button>
            {self ? null : (
              <Button size="sm" variant="quiet" className="text-status-critical hover:text-status-critical" onClick={onDelete}>
                Delete
              </Button>
            )}
          </span>
        </td>
      </tr>
      {editing ? <PasswordRow user={user} onSaved={onSaved} onCancel={onCancel} /> : null}
    </>
  );
}
