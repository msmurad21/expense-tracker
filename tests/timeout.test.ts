import { describe, it, expect } from 'vitest';
import { withTimeout, MailTimeoutError } from '../src/main/mail/MailSource.js';

describe('withTimeout', () => {
  it('passes a value through when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('propagates a rejection unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('nope')), 1000)).rejects.toThrow('nope');
  });

  it('rejects with guidance when nothing answers', async () => {
    // The real case: a firewall silently drops port 993, so the connection
    // neither succeeds nor fails and setup would otherwise hang forever.
    const neverSettles = new Promise<never>(() => {});

    await expect(withTimeout(neverSettles, 50)).rejects.toBeInstanceOf(MailTimeoutError);
  });

  it('gives the caller a chance to tear down the abandoned work', async () => {
    // Without this the socket stays open and keeps the process alive long
    // after the caller has given up on it.
    let cleanedUp = false;
    const neverSettles = new Promise<never>(() => {});

    await withTimeout(neverSettles, 50, () => {
      cleanedUp = true;
    }).catch(() => undefined);

    expect(cleanedUp).toBe(true);
  });

  it('explains that a blocked port is the likely cause', async () => {
    const error = await withTimeout(new Promise<never>(() => {}), 30).catch((e: unknown) => e);
    expect((error as MailTimeoutError).fix).toContain('993');
  });

  it('does not leave a timer holding the process open', async () => {
    // If the timer were not cleared on the success path, a short-lived script
    // would sit idle until it fired.
    const started = Date.now();
    await withTimeout(Promise.resolve('fast'), 60_000);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
