// Encodes a session JSON (as stored in the app's IndexedDB) into the .delta wire format:
// length-delimited protobuf: one SessionMessage followed by one LapMessage per lap.
import protobuf from 'protobufjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const Step = new protobuf.Type('StepMessage')
  .add(new protobuf.Field('steering', 1, 'float'))
  .add(new protobuf.Field('throttle', 2, 'float'))
  .add(new protobuf.Field('brake', 3, 'float'))
  .add(new protobuf.Field('speed', 4, 'float'))
  .add(new protobuf.Field('slipAngle', 5, 'float', 'repeated'))
  .add(new protobuf.Field('tyreTemps', 6, 'float', 'repeated'))
  .add(new protobuf.Field('tyrePressures', 7, 'float', 'repeated'))
  .add(new protobuf.Field('gear', 8, 'int32'))
  .add(new protobuf.Field('rpm', 9, 'int32'))
  .add(new protobuf.Field('trackPct', 10, 'float'))
  .add(new protobuf.Field('stopwatch', 11, 'int32'))
  .add(new protobuf.Field('fuel', 12, 'float'))
  .add(new protobuf.Field('coordinates', 13, 'float', 'repeated'))
  .add(new protobuf.Field('virtualEnergy', 14, 'float', 'optional'))
  .add(new protobuf.Field('tyreWear', 15, 'float', 'repeated'));
const Lap = new protobuf.Type('LapMessage')
  .add(new protobuf.Field('lapNumber', 1, 'int32'))
  .add(new protobuf.Field('trackTemp', 2, 'float'))
  .add(new protobuf.Field('airTemp', 3, 'float'))
  .add(new protobuf.Field('rainIntensity', 4, 'float'))
  .add(new protobuf.Field('lapTime', 5, 'int32'))
  .add(new protobuf.Field('steps', 6, 'StepMessage', 'repeated'))
  .add(new protobuf.Field('isValid', 7, 'bool'))
  .add(new protobuf.Field('isInlap', 8, 'bool'))
  .add(new protobuf.Field('isOutlap', 9, 'bool'))
  .add(new protobuf.Field('fuelLevel', 10, 'float'))
  .add(new protobuf.Field('fuelUsage', 11, 'float'))
  .add(new protobuf.Field('sectorTimes', 12, 'int32', 'repeated'))
  .add(new protobuf.Field('virtualEnergyLevel', 13, 'float', 'optional'))
  .add(new protobuf.Field('virtualEnergyUsage', 14, 'float', 'optional'))
  .add(new protobuf.Field('setupName', 15, 'string', 'optional'))
  .add(new protobuf.Field('setupIsFixed', 16, 'bool', 'optional'))
  .add(new protobuf.Field('tyreCompound', 17, 'string', 'repeated'))
  .add(new protobuf.Field('tyreWearStart', 18, 'float', 'repeated'))
  .add(new protobuf.Field('tyreWearEnd', 19, 'float', 'repeated'));
const Session = new protobuf.Type('SessionMessage')
  .add(new protobuf.Field('car', 1, 'string'))
  .add(new protobuf.Field('track', 2, 'string'))
  .add(new protobuf.Field('sessionType', 3, 'string'))
  .add(new protobuf.Field('fileVersion', 4, 'int32'))
  .add(new protobuf.Field('sim', 5, 'string'));
const ns = new protobuf.Root(); ns.add(Step).add(Lap).add(Session); ns.resolveAll();

const clean = (o) => { const r = {}; for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) r[k] = v; return r; };
export function encodeSession(json) {
  const chunks = [];
  chunks.push(Session.encodeDelimited(Session.fromObject(clean(json.session))).finish());
  for (const lap of json.laps) {
    const { stats, ...rest } = lap;
    const l = clean(rest); l.steps = (lap.steps || []).map(clean);
    chunks.push(Lap.encodeDelimited(Lap.fromObject(l)).finish());
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
export function decodeSession(buf) {
  const r = protobuf.Reader.create(buf); const session = Session.toObject(Session.decodeDelimited(r)); const laps = [];
  while (r.pos < r.len) laps.push(Lap.toObject(Lap.decodeDelimited(r)));
  return { session, laps };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [src, dst] of [['onboarding-demo.json', 'onboarding-demo.delta'], ['reference-session.json', 'reference-session.delta']]) {
    const json = JSON.parse(fs.readFileSync(path.join(root, 'data', src), 'utf8'));
    const buf = encodeSession(json); fs.writeFileSync(path.join(root, 'data', dst), buf);
    const back = decodeSession(buf);
    console.log(dst, buf.length, 'bytes;', 'laps', back.laps.length, 'steps lap1', back.laps[0].steps.length, 'session', JSON.stringify(back.session));
  }
}
