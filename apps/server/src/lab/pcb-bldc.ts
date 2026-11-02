/**
 * A dense real-world board to start from: a three-phase motor controller, 24 V in, with half-bridge
 * gate drivers, six power MOSFETs, a current shunt per phase, a buck converter and an LDO, and a
 * microcontroller with hall and programming connectors. Connections follow the parts' datasheets
 * (pin 1 of a diode is its cathode); the values are a sensible first pass, not a tuned power stage.
 * Where each part sits is decided here, in groups as an engineer would; the lab routes it and checks
 * the result.
 */

interface Part {
  ref: string;
  footprint: string;
  value?: string;
  at: [number, number];
  rot?: 0 | 90 | 180 | 270;
}
interface Net {
  name: string;
  pins: string[];
  class?: 'power';
  width_mm?: number;
}

const parts: Part[] = [];
const netPins = new Map<string, { pins: string[]; power?: boolean; width?: number }>();

// Between the bridges and the logic below them runs a free channel for the signals that cross over.
const CHANNEL = 6;

const part = (
  ref: string,
  footprint: string,
  value: string,
  x: number,
  y: number,
  rot: Part['rot'] = 0,
) =>
  parts.push({
    ref,
    footprint,
    value,
    at: [x, y >= 40 ? y + CHANNEL : y],
    ...(rot ? { rot } : {}),
  });

const net = (name: string, pins: string[], style: { power?: boolean; width?: number } = {}) => {
  const n = netPins.get(name) ?? { pins: [], ...style };
  n.pins.push(...pins);
  netPins.set(name, n);
};
const GND = (...pins: string[]) => net('GND', pins, { width: 0.3 });
const P3V3 = (...pins: string[]) => net('3V3', pins, { width: 0.3 });
const P12V = (...pins: string[]) => net('12V', pins, { width: 0.25 });
const VM = (...pins: string[]) => net('VM', pins, { width: 0.8 });

// Mounting holes in the corners, power and phase pads along the edges.
part('H1', 'HOLE3.2', 'M3', 4, 4);
part('H2', 'HOLE3.2', 'M3', 66, 4);
part('H3', 'HOLE3.2', 'M3', 4, 66);
part('H4', 'HOLE3.2', 'M3', 66, 66);
part('TP1', 'PAD_TH3', 'VM', 4, 13);
part('TP2', 'PAD_TH3', 'GND', 4, 22);
part('TP3', 'PAD_TH3', 'PHASE C', 66, 13);
part('TP4', 'PAD_TH3', 'PHASE B', 66, 22);
part('TP5', 'PAD_TH3', 'PHASE A', 66, 31);
VM('TP1.1');
GND('TP2.1');

// Bulk capacitors and the input.
part('C1', 'CAPE10', '470u 35V', 14, 11);
part('C2', 'CAPE10', '100u 35V', 14, 24);
VM('C1.1', 'C2.1');
GND('C1.2', 'C2.2');

// Three identical half bridges along the top.
['A', 'B', 'C'].forEach((ph, i) => {
  const x = 26 + i * 13.5;
  const n = i * 10;
  const hi = `Q${1 + i * 2}`;
  const lo = `Q${2 + i * 2}`;
  const drv = `U${2 + i}`;
  const rg = (k: number) => `R${10 + n + k}`;
  const c = (k: number) => `C${10 + n + k}`;
  const out = `PH_${ph}`;
  part(hi, 'PQFN5X6', 'BSC060N10', x, 7, 90);
  part(lo, 'PQFN5X6', 'BSC060N10', x, 16, 90);
  part(`R${n + 40}`, 'R2512', '5m', x, 24);
  part(drv, 'SOIC8', 'IR2104', x, 32);
  part(rg(1), 'R0603', '10', x - 5, 8, 90);
  part(rg(2), 'R0603', '10', x - 5, 17, 90);
  part(rg(3), 'R0603', '4k7', x - 5.6, 30.5);
  part(rg(4), 'R0603', '4k7', x - 5.6, 33);
  part(c(1), 'C0805', '100n', x + 5, 31, 90);
  part(c(2), 'C0805', '1u', x - 5.6, 36);
  part(`D${10 + i}`, 'SOD123', '1N4148W', x, 38, 180);

  VM(`${hi}.5`);
  net(out, [`${hi}.1`, `${hi}.2`, `${hi}.3`, `${lo}.5`, `TP${5 - i}.1`, `${drv}.6`, `${c(1)}.2`], {
    width: 0.5,
  });
  net(`GH_${ph}`, [`${hi}.4`, `${rg(1)}.1`]);
  net(`HO_${ph}`, [`${rg(1)}.2`, `${drv}.7`]);
  net(`GL_${ph}`, [`${lo}.4`, `${rg(2)}.1`]);
  net(`LO_${ph}`, [`${rg(2)}.2`, `${drv}.5`]);
  net(`SH_${ph}`, [`${lo}.1`, `${lo}.2`, `${lo}.3`, `R${n + 40}.1`], { width: 0.5 });
  GND(`R${n + 40}.2`, `${drv}.4`, `${c(2)}.2`, `${rg(3)}.2`, `${rg(4)}.2`);
  net(`VB_${ph}`, [`${drv}.8`, `${c(1)}.1`, `D${10 + i}.1`]);
  P12V(`${drv}.1`, `${c(2)}.1`, `D${10 + i}.2`);
  net(`IN_${ph}`, [`${drv}.2`, `${rg(3)}.1`]);
  net(`SD_${ph}`, [`${drv}.3`, `${rg(4)}.1`]);
});

// The 12 V buck converter and the 3.3 V regulator, on the left.
part('U5', 'SOIC8', 'MP1584', 9, 37);
part('L1', 'L_SMD6', '33u', 9, 47);
part('D1', 'SOD123', 'PMEG6010', 15, 42, 90);
part('C3', 'C1206', '10u 35V', 4, 31, 90);
part('C4', 'C1206', '22u', 15, 48, 90);
part('C5', 'C0603', '100n', 15, 36);
part('R1', 'R0603', '100k', 4, 40, 90);
part('R2', 'R0603', '7k15', 4, 44, 90);
part('R3', 'R0603', '100k', 15.5, 32);
part('R4', 'R0603', '100k', 18.5, 40);
part('R5', 'R0603', '100k', 18.5, 45);
part('C8', 'C0603', '150p', 18.5, 48);
part('U6', 'SOT223', 'AMS1117-3.3', 10, 56);
part('C6', 'C0805', '10u', 4, 52, 90);
part('C7', 'C0805', '10u', 16, 56, 90);
VM('U5.7', 'C3.1', 'R3.1');
GND('C3.2', 'U5.5', 'C4.2', 'R2.2', 'D1.2', 'C6.2', 'C7.2', 'U6.1', 'R4.2', 'C8.2');
net('SW', ['U5.1', 'L1.1', 'D1.1', 'C5.2']);
net('BST', ['U5.8', 'C5.1']);
P12V('L1.2', 'C4.1', 'R1.1', 'U6.3', 'C6.1');
net('FB', ['U5.4', 'R1.2', 'R2.1']);
net('EN', ['U5.2', 'R3.2']);
net('FREQ', ['U5.6', 'R4.1']);
net('COMP', ['U5.3', 'R5.1']);
net('COMP_C', ['R5.2', 'C8.1']);
P3V3('U6.2', 'U6.2b', 'C7.1');

// Current amplifiers below the bridges.
part('U7', 'SOIC8', 'LM358', 27, 46);
part('U8', 'SOIC8', 'LM358', 53, 46);
part('R70', 'R0603', '1k', 22, 42);
part('R71', 'R0603', '47k', 27, 41);
part('R72', 'R0603', '1k', 22, 50);
part('R73', 'R0603', '47k', 27, 51);
part('R74', 'R0603', '1k', 48, 42);
part('R75', 'R0603', '47k', 53, 41);
part('C50', 'C0603', '100n', 32, 42);
part('C51', 'C0603', '100n', 58, 42);
P3V3('U7.8', 'U8.8', 'C50.1', 'C51.1');
GND('U7.4', 'U8.4', 'C50.2', 'C51.2');
// Each shunt's top side goes straight to a plus input: gain 1 + 47k/1k, ground-referenced.
net('SH_A', ['U7.3']);
net('SH_B', ['U7.5']);
net('SH_C', ['U8.3']);
GND('R70.1', 'R72.1', 'R74.1');
net('INA', ['R70.2', 'R71.1', 'U7.2']);
net('INB', ['R72.2', 'R73.1', 'U7.6']);
net('INC', ['R74.2', 'R75.1', 'U8.2']);
net('ISA', ['R71.2', 'U7.1']);
net('ISB', ['R73.2', 'U7.7']);
net('ISC', ['R75.2', 'U8.1']);
// The spare amplifier follows ground, so it stays quiet.
GND('U8.5');
net('SPARE', ['U8.6', 'U8.7']);

// The microcontroller, in the middle at the bottom.
part('U1', 'TQFP44', 'ATMEGA1284', 40, 56);
part('C60', 'C0603', '100n', 33, 48);
part('C61', 'C0603', '100n', 47, 48);
part('C62', 'C0603', '100n', 33, 64);
part('C63', 'C0603', '100n', 47, 64);
part('R20', 'R0603', '10k', 30, 56, 90);
part('Y1', 'XTAL3225', '8M', 30.4, 60.2, 90);
part('C64', 'C0603', '18p', 27.6, 57.4, 90);
part('C65', 'C0603', '18p', 27.6, 63, 90);
part('C66', 'C0603', '100n', 49, 55);
// AVCC is pin 27; pin 29 is AREF.
P3V3('U1.5', 'U1.17', 'U1.27', 'U1.38', 'C60.1', 'C61.1', 'C62.1', 'C63.1', 'R20.1');
GND(
  'U1.6',
  'U1.18',
  'U1.28',
  'U1.39',
  'C60.2',
  'C61.2',
  'C62.2',
  'C63.2',
  'C64.2',
  'C65.2',
  'C66.2',
  'Y1.2',
  'Y1.4',
);
net('AREF', ['U1.29', 'C66.1']);
net('XT1', ['U1.8', 'Y1.1', 'C64.1']);
net('XT2', ['U1.7', 'Y1.3', 'C65.1']);
net('RESET', ['U1.4', 'R20.2', 'J2.5', 'SW1.1', 'SW1.2']);
GND('SW1.3', 'SW1.4');
net('USER', ['U1.22', 'SW2.1', 'SW2.2']);
GND('SW2.3', 'SW2.4');
part('SW1', 'SW_TACT', 'RESET', 22.5, 62);
part('SW2', 'SW_TACT', 'USER', 59, 62, 180);

// PWM from timer outputs OC0A, OC0B and OC2A, shutdown from plain outputs, currents to ADC0..2.
net('IN_A', ['U1.43']);
net('IN_B', ['U1.44']);
net('IN_C', ['U1.16']);
net('SD_A', ['U1.42']);
net('SD_B', ['U1.41']);
net('SD_C', ['U1.40']);
net('ISA', ['U1.37']);
net('ISB', ['U1.36']);
net('ISC', ['U1.35']);

// Connectors, status lights.
part('J1', 'JST6', 'HALL', 62, 52, 90);
part('J2', 'JST6', 'ISP', 12.2, 64);
part('D5', 'LED0603', 'green', 33, 67);
part('D6', 'LED0603', 'red', 47, 67);
part('R80', 'R0603', '470', 37, 67);
part('R81', 'R0603', '470', 43, 67);
// The hall inputs use the microcontroller's own pull-ups.
net('HALL_A', ['J1.1', 'U1.34']);
net('HALL_B', ['J1.2', 'U1.33']);
net('HALL_C', ['J1.3', 'U1.32']);
P3V3('J1.4', 'J2.1');
GND('J1.5', 'J2.6');
net('TEMP', ['J1.6', 'U1.30']);
net('MOSI', ['J2.2', 'U1.1']);
net('MISO', ['J2.3', 'U1.2']);
net('SCK', ['J2.4', 'U1.3']);
net('LED_G', ['U1.20', 'R80.1']);
net('LED_R', ['U1.21', 'R81.1']);
net('LA_G', ['R80.2', 'D5.2']);
net('LA_R', ['R81.2', 'D6.2']);
GND('D5.1', 'D6.1');

const nets: Net[] = [...netPins.entries()].map(([name, n]) => ({
  name,
  pins: n.pins,
  ...(n.power ? { class: 'power' as const } : {}),
  ...(n.width ? { width_mm: n.width } : {}),
}));

/** The whole design, ready for the lab. */
export const BLDC_DRIVER = {
  board: { width_mm: 70, height_mm: 70 + CHANNEL },
  rules: {
    clearance_mm: 0.2,
    track_mm: 0.2,
    power_track_mm: 0.5,
    via_dia_mm: 0.6,
    via_drill_mm: 0.3,
    edge_clearance_mm: 0.3,
    grid_mm: 0.2,
    via_cost: 12,
  },
  routing_seconds: 300,
  // The order the router found works for this layout: it gets there on the first try.
  route_first: [
    'GND',
    'SD_B',
    'HO_C',
    'PH_C',
    'SD_A',
    'SH_C',
    '12V',
    'PH_A',
    'XT2',
    'LED_G',
    'IN_C',
    'INB',
    'ISC',
    'AREF',
    'LA_G',
    'FB',
    'FREQ',
    'SH_B',
    'BST',
    'LO_C',
    'VM',
    'HO_B',
    'INC',
    'ISA',
    'SPARE',
    'GL_A',
    'SCK',
    'SH_A',
    'COMP_C',
    'TEMP',
    'VB_B',
    'HO_A',
    'GH_B',
    'LO_B',
    '3V3',
    'LED_R',
    'VB_A',
    'RESET',
    'SD_C',
    'MISO',
    'SW',
    'ISB',
    'HALL_B',
    'VB_C',
    'HALL_C',
    'GL_B',
    'EN',
    'LA_R',
    'LO_A',
    'GH_C',
    'PH_B',
    'COMP',
    'XT1',
    'IN_A',
    'MOSI',
    'IN_B',
    'INA',
    'USER',
    'GH_A',
    'HALL_A',
    'GL_C',
  ],
  rails: { VM: 24 },
  bench: 'bldc_six_step' as const,
  parts,
  nets,
  pours: [
    { net: 'GND', layer: 'B.Cu' as const },
    { net: 'GND', layer: 'F.Cu' as const },
    {
      net: 'VM',
      layer: 'F.Cu' as const,
      rect: [0.5, 0.5, 69.5, 12] as [number, number, number, number],
      priority: 1,
    },
  ],
};
