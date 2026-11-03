import { describe, expect, it } from 'vitest';
import {
  describeLearned,
  installLine,
  installsIn,
  parseInstallLines,
  restoreCommands,
} from './learned.ts';

describe('what a bot installs, learned and brought back', () => {
  it('reads the packages from apt-get, pip and conda calls, not their options or files', () => {
    expect(
      installsIn(
        'sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends pymol 2>&1 | tail -1',
      ),
    ).toEqual([{ manager: 'apt', package: 'pymol' }]);
    expect(installsIn('python3 -m pip install -q biopython "numpy>=2" -r req.txt rdkit')).toEqual([
      { manager: 'pip', package: 'biopython' },
      { manager: 'pip', package: 'numpy' },
      { manager: 'pip', package: 'rdkit' },
    ]);
    expect(installsIn('conda install -y -c bioconda samtools')).toEqual([
      { manager: 'conda', package: 'samtools' },
    ]);
    expect(installsIn('pip install ./local/pkg; echo apt-get')).toEqual([]);
    expect(installsIn('ls ~/workspace')).toEqual([]);
  });

  it('keeps one line per package and reads only well-formed lines back', () => {
    const lines = [{ manager: 'apt', package: 'pymol' } as const].map(installLine).join('\n');
    expect(parseInstallLines(`${lines}\npip biopython\nrm -rf /\napt $(evil)\n`)).toEqual([
      { manager: 'apt', package: 'pymol' },
      { manager: 'pip', package: 'biopython' },
    ]);
  });

  it('brings packages back one at a time, so a missing one does not stop the rest', () => {
    const [apt, pip] = restoreCommands([
      { manager: 'apt', package: 'pymol' },
      { manager: 'apt', package: 'gromacs' },
      { manager: 'pip', package: 'biopython' },
    ]);
    expect(apt).toContain('for p in pymol gromacs; do');
    expect(apt).toContain('echo "not restored $p"');
    expect(pip).toContain('python3 -m pip install -q "$p"');
  });

  it('tells the next bot how to get a tool and what it opened', () => {
    expect(
      describeLearned([
        { manager: 'apt', package: 'pymol', program: 'pymol', opens: ['pdb', 'pml'], uses: 3 },
      ]),
    ).toBe('- pymol (sudo apt-get install -y pymol); opens .pdb, .pml with pymol; used 3x');
  });
});

describe('programs that come with the computer', () => {
  it('are described as already there, with what they opened', () => {
    expect(
      describeLearned([
        { manager: 'image', package: 'pcbnew', program: 'pcbnew', opens: ['kicad_pcb'], uses: 1 },
      ]),
    ).toBe('- pcbnew (already on the computer); opens .kicad_pcb with pcbnew; used 1x');
  });

  it('are never installed again', () => {
    expect(parseInstallLines('image pcbnew\napt pymol')).toEqual([
      { manager: 'apt', package: 'pymol' },
    ]);
  });
});
