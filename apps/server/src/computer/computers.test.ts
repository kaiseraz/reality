import { describe, expect, it } from 'vitest';
import { isBackgroundHost, normalizeDomain } from './computers.ts';

describe('bot computer access rules', () => {
  it('accepts plain domains and strips schemes, paths, ports and www', () => {
    expect(normalizeDomain('pypi.org')).toBe('pypi.org');
    expect(normalizeDomain('https://www.Wikipedia.org/wiki/Jet')).toBe('wikipedia.org');
    expect(normalizeDomain('*.github.com')).toBe('github.com');
    expect(normalizeDomain('files.pythonhosted.org:443')).toBe('files.pythonhosted.org');
  });

  it('refuses anything that is not a host name', () => {
    for (const bad of [
      '',
      'localhost',
      '127.0.0.1',
      '*',
      'pypi',
      'a b.org',
      'host.docker.internal:x',
    ]) {
      expect(normalizeDomain(bad), bad).toBeNull();
    }
  });

  it('treats the browser’s own background calls as noise, not as the bot’s requests', () => {
    expect(isBackgroundHost('accounts.google.com')).toBe(true);
    expect(isBackgroundHost('update.googleapis.com')).toBe(true);
    expect(isBackgroundHost('example.com')).toBe(false);
    expect(isBackgroundHost('notgoogle.com')).toBe(false);
  });
});
