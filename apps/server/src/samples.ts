import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Example datasets shipped in <repo>/samples, offered on the start screen. */
export interface Sample {
  id: string;
  file: string;
  title: string;
  description: string;
  question: string;
  source: string;
}

export const SAMPLES: readonly Sample[] = [
  {
    id: 'co2',
    file: 'real/co2_mm_mlo.csv',
    title: 'Mauna Loa CO₂',
    description: '68 years of monthly CO₂ measurements. Real data with comments and gaps.',
    question: 'Is there a seasonal cycle in monthly CO2 at Mauna Loa, and how strong is it?',
    source: 'Public-domain government dataset (sources: samples/real/README.md)',
  },
  {
    id: 'bike',
    file: 'real/bike_day.csv',
    title: 'Bike sharing',
    description: 'Two years of daily bike rentals in Washington, D.C., with weather.',
    question: 'Which weather situation (weathersit) drives bike rentals (cnt)?',
    source: 'Public research dataset, CC BY 4.0 (sources: samples/real/README.md)',
  },
  {
    id: 'sales',
    file: 'sales_weekly.csv',
    title: 'Weekly sales',
    description: 'Three years of weekly revenue for two regions. Synthetic, with known answers.',
    question: 'Is there a seasonal pattern in weekly revenue, and which regions drive it?',
    source: 'Synthetic (samples/generate-sales.mjs)',
  },
];

export function findSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

export async function readSample(dir: string, sample: Sample): Promise<string> {
  return readFile(join(dir, sample.file), 'utf8');
}
