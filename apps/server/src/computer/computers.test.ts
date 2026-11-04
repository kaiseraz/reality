import { describe, expect, it } from 'vitest';
import { computerPath, isBackgroundHost, normalizeDomain, siteOf } from './computers.ts';
import { viewerFor } from '../chat/tools.ts';

describe('paths and programs on a bot computer', () => {
  it('reads ~ as the home of the bot shell, and a bare name as the workspace', () => {
    expect(computerPath('~/workspace/show.pml')).toBe('/home/gem/workspace/show.pml');
    expect(computerPath('~')).toBe('/home/gem');
    expect(computerPath('show.pml')).toBe('/home/gem/workspace/show.pml');
    expect(computerPath(' /tmp/a.txt ')).toBe('/tmp/a.txt');
    expect(() => computerPath('  ')).toThrow();
  });

  it('opens each file type in its program, and a program the bot names for anything else', () => {
    expect(viewerFor('/x/board.kicad_pcb')).toBe('pcbnew');
    expect(viewerFor('/x/engine.STEP')).toBe('freecad');
    expect(viewerFor('/x/1TCA.pdb')).toBe('pymol');
    expect(viewerFor('/x/ligand.sdf')).toBe('pymol');
    expect(viewerFor('/x/case.vtu')).toBe('paraview');
    expect(viewerFor('/x/cavity.foam')).toBe('paraview');
    expect(viewerFor('/x/plate.msh')).toBe('gmsh');
    expect(viewerFor('/x/notes.txt')).toBeNull();
    expect(viewerFor('/x/rivers.geojson', 'qgis')).toBe('qgis');
  });
});

describe('bot computer access rules', () => {
  it('asks once per site, not once per host a page reaches for', () => {
    expect(siteOf('upload.wikimedia.org')).toBe('wikimedia.org');
    expect(siteOf('https://en.wikipedia.org/wiki/Lipase')).toBe('wikipedia.org');
    expect(siteOf('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(siteOf('localhost')).toBeNull();
  });

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
