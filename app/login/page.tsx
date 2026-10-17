'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useBrand } from '../BrandProvider';

export default function LoginPage() {
  const router = useRouter();
  const { appName } = useBrand();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace('/');
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not sign in.');
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>{appName}</h1>
      <p>One password. This device stays signed in for 30 days.</p>
      <form onSubmit={submit}>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          autoFocus
          aria-label="Password"
        />
        <div className="err" role="alert">{error}</div>
        <button className="primary" type="submit" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Open'}
        </button>
      </form>
    </main>
  );
}
