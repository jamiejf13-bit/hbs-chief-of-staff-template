'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The chat box in the top right.
 *
 * Deliberately small and stateless-across-reloads: it is for "add a to-do to
 * email Pat before Thursday" and "block two hours for the case tomorrow
 * morning", not for a conversation you are meant to keep.
 *
 * Whatever it changes shows up in the page below, because the handler writes
 * to the same database the page reads — so `onDone` reloads rather than the
 * chat trying to describe what moved.
 */

type Turn = { role: 'user' | 'assistant'; text: string; did?: string[] };

export default function AgentChat({ disabled, onDone }: { disabled: boolean; onDone: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** What you typed when a send failed, kept so it is not lost. */
  const [failed, setFailed] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, busy]);

  /**
   * Send, and fail in a way you can act on.
   *
   * "Could not reach the server" was every failure: a dropped connection, a
   * request that ran past the function's 60-second limit, an expired session,
   * or iOS suspending the tab after switching apps mid-answer. It also
   * cleared what had been typed, so the only route back was to write it again
   * from memory. The causes need telling apart and the words need keeping.
   */
  async function send(retryOf?: string) {
    const msg = (retryOf ?? text).trim();
    if (!msg || busy) return;

    const next: Turn[] = retryOf
      ? turns
      : [...turns, { role: 'user', text: msg }];
    if (!retryOf) setTurns(next);
    setText('');
    setBusy(true);
    setErr(null);
    setFailed(null);

    // Just inside the server's own ceiling, so a request that is never coming
    // back says so rather than hanging until the browser gives up silently.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort('timeout'), 62_000);

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: abort.signal,
        // Only the plain text of prior turns travels back; tool blocks are
        // resolved server-side within a single request.
        body: JSON.stringify({
          messages: next.map((t) => ({ role: t.role, content: t.text })),
        }),
      });

      // A signed-out session redirects to the login page, which answers 200
      // with HTML. Parsed as JSON that is an empty object and an empty reply,
      // which read as the agent having nothing to say.
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('application/json')) {
        setErr('Your session has expired — reload the page and sign in again.');
        setFailed(msg);
        return;
      }

      const b = await res.json().catch(() => ({}));

      if (!res.ok) {
        setErr(b.error ?? `Failed (${res.status}).`);
        setFailed(msg);
        return;
      }
      setTurns([...next, { role: 'assistant', text: b.reply ?? '', did: b.did ?? [] }]);
      if (b.did?.length) onDone();
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      setErr(aborted
        ? 'That took longer than a minute and was cut off. It may still have gone through — check before sending it again.'
        : 'Could not reach the server. If you switched apps mid-answer, the phone stopped the request.');
      setFailed(msg);
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      <div className="chathead">Ask the agent</div>

      <div className="chatlog" ref={logRef}>
        {turns.length === 0 && !busy && (
          <p className="chathint">
            &ldquo;Add a to-do to email Pat before Thursday&rdquo; · &ldquo;Block two hours
            tomorrow morning for the case&rdquo; · &ldquo;Make the coffee chats social&rdquo;
          </p>
        )}

        {turns.map((t, i) => (
          <div className={`ct ${t.role}`} key={i}>
            <p>{t.text}</p>
            {/* What it actually changed, listed separately from what it said.
                Prose can be vague; this cannot. */}
            {t.did && t.did.length > 0 && (
              <ul className="cdid">
                {t.did.map((d, j) => <li key={j}>{d}</li>)}
              </ul>
            )}
          </div>
        ))}

        {busy && <div className="ct assistant"><p className="thinking">Working…</p></div>}
        {err && (
          <div className="ct err">
            <p>{err}</p>
            {failed && (
              <p className="retry">
                <button className="linkish" onClick={() => void send(failed)}>Send it again</button>
                {' · '}
                <span className="kept">“{failed.slice(0, 60)}{failed.length > 60 ? '…' : ''}”</span>
              </p>
            )}
          </div>
        )}
      </div>

      <form
        className="chatform"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={disabled ? 'Sample data — chat is off' : 'What do you need done?'}
          aria-label="Message the agent"
          disabled={disabled || busy}
          maxLength={2000}
        />
        <button className="btn-ok" disabled={disabled || busy || !text.trim()}>Send</button>
      </form>
    </div>
  );
}
