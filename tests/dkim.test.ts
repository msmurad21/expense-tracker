import { describe, it, expect } from 'vitest';
import { extractDkimDomain } from '../src/main/mail/ImapSource.js';

/**
 * The app does not verify DKIM itself — Gmail already did, on receipt, and
 * recorded the verdict. These tests cover reading that verdict correctly,
 * because everything the parser trusts hangs off it.
 */

describe('extractDkimDomain — reading Gmail’s verdict', () => {
  it('returns the signing domain when DKIM passed', () => {
    const headers = [
      'Delivered-To: someone@gmail.com',
      'Authentication-Results: mx.google.com; dkim=pass header.d=hbl.com; spf=pass smtp.mailfrom=hbl.com',
      'From: alerts@hbl.com',
    ].join('\n');

    expect(extractDkimDomain(headers)).toBe('hbl.com');
  });

  it('lowercases the domain', () => {
    const headers = 'Authentication-Results: mx.google.com; dkim=pass header.d=HBL.COM';
    expect(extractDkimDomain(headers)).toBe('hbl.com');
  });

  it('is insensitive to header name casing', () => {
    const headers = 'AUTHENTICATION-RESULTS: mx.google.com; DKIM=PASS HEADER.D=netflix.com';
    expect(extractDkimDomain(headers)).toBe('netflix.com');
  });

  it('handles a folded header', () => {
    const headers =
      'Authentication-Results: mx.google.com;\r\n       dkim=pass header.d=netflix.com;\r\n       spf=pass';
    expect(extractDkimDomain(headers)).toBe('netflix.com');
  });
});

describe('extractDkimDomain — the header.i form Gmail actually uses', () => {
  // Reading only header.d reported an entire real inbox of 3768 messages as
  // unverified, including Google's own mail, which silently disabled all
  // parsing. RFC 8601 permits both identifiers and Gmail prefers header.i.

  it('reads header.i, stripping the leading @', () => {
    const headers =
      'Authentication-Results: mx.google.com; dkim=pass header.i=@sc.com header.s=s1 header.b=Ab1; spf=pass';
    expect(extractDkimDomain(headers)).toBe('sc.com');
  });

  it('reads header.i when it carries a local part', () => {
    const headers = 'Authentication-Results: mx.google.com; dkim=pass header.i=alerts@nayapay.com';
    expect(extractDkimDomain(headers)).toBe('nayapay.com');
  });

  it('reads header.i across a folded header', () => {
    const headers = [
      'Authentication-Results: mx.google.com;',
      '       dkim=pass header.i=@elevatepay.co header.s=sel header.b=xY9;',
      '       spf=pass (google.com: domain of x designates 1.2.3.4) smtp.mailfrom=x@elevatepay.co;',
      '       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=elevatepay.co',
    ].join('\r\n');
    expect(extractDkimDomain(headers)).toBe('elevatepay.co');
  });

  it('prefers header.d when both are present', () => {
    // header.d is the signing domain proper; header.i may be a subdomain of it.
    const headers =
      'Authentication-Results: mx.google.com; dkim=pass header.d=sc.com header.i=@mail.sc.com';
    expect(extractDkimDomain(headers)).toBe('sc.com');
  });

  it('does not accept header.i from a failing signature', () => {
    const headers = 'Authentication-Results: mx.google.com; dkim=fail header.i=@sc.com';
    expect(extractDkimDomain(headers)).toBeNull();
  });

  it('ignores header.from, which is not an authentication result', () => {
    // header.from is just the From header echoed back; it is not signed and
    // must never stand in for a verified domain.
    const headers =
      'Authentication-Results: mx.google.com; dkim=none; spf=fail; dmarc=fail header.from=sc.com';
    expect(extractDkimDomain(headers)).toBeNull();
  });
});

describe('extractDkimDomain — refuses anything short of a pass', () => {
  it('returns null when DKIM failed', () => {
    const headers = 'Authentication-Results: mx.google.com; dkim=fail header.d=hbl.com';
    expect(extractDkimDomain(headers)).toBeNull();
  });

  it('returns null when there was no signature', () => {
    const headers = 'Authentication-Results: mx.google.com; dkim=none; spf=pass';
    expect(extractDkimDomain(headers)).toBeNull();
  });

  it('returns null for a temporary or permanent error verdict', () => {
    expect(
      extractDkimDomain('Authentication-Results: mx.google.com; dkim=temperror header.d=hbl.com'),
    ).toBeNull();
    expect(
      extractDkimDomain('Authentication-Results: mx.google.com; dkim=permerror header.d=hbl.com'),
    ).toBeNull();
  });

  it('returns null when the header is absent entirely', () => {
    expect(extractDkimDomain('From: alerts@hbl.com\nSubject: Transaction Alert')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractDkimDomain('')).toBeNull();
  });
});

describe('extractDkimDomain — resists forgery', () => {
  it('ignores an Authentication-Results header supplied by the sender', () => {
    // Gmail prepends its own header on delivery. Anything below it arrived with
    // the message and may have been written by whoever sent it — so a forged
    // "dkim=pass header.d=hbl.com" underneath must not be believed.
    const headers = [
      'Authentication-Results: mx.google.com; dkim=none; spf=fail',
      'Authentication-Results: attacker-controlled; dkim=pass header.d=hbl.com',
      'From: alerts@hbl.com',
    ].join('\n');

    expect(extractDkimDomain(headers)).toBeNull();
  });

  it('pairs each verdict with its own domain when a message has several signatures', () => {
    // A failing signature for the bank must not borrow the passing signature
    // of an unrelated domain.
    const headers =
      'Authentication-Results: mx.google.com; dkim=fail header.d=hbl.com; dkim=pass header.d=mailchimp.com';

    expect(extractDkimDomain(headers)).toBe('mailchimp.com');
  });

  it('does not treat a domain mentioned elsewhere as verified', () => {
    const headers =
      'Authentication-Results: mx.google.com; dkim=none; spf=pass smtp.mailfrom=hbl.com';
    expect(extractDkimDomain(headers)).toBeNull();
  });
});
