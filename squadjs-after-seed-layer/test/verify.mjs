// Self-contained verification for AfterSeedLayer — no live SquadJS server.
// Sets up a temp dir with a BasePlugin stub + the real plugin source, mocks the
// EventEmitter `server` (Squad's next-layer state sits behind a fake RCON), fakes the
// weekday, and asserts the behaviour.
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = path.join(HERE, '..', 'after-seed-layer.js');

// --- BasePlugin stub matching the real option-resolution contract ---------------
const BASE_PLUGIN_STUB = `export default class BasePlugin {
  constructor(server, options, connectors) {
    this.server = server;
    this.options = {};
    this.rawOptions = options || {};
    for (const [name, opt] of Object.entries(this.constructor.optionsSpecification)) {
      if (opt.connector) this.options[name] = (connectors || {})[this.rawOptions[name]];
      else this.options[name] = typeof this.rawOptions[name] !== 'undefined' ? this.rawOptions[name] : opt.default;
    }
  }
  async prepareToMount() {}
  async mount() {}
  async unmount() {}
  verbose() {}
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-'));
fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
fs.writeFileSync(path.join(tmp, 'base-plugin.js'), BASE_PLUGIN_STUB);
fs.copyFileSync(PLUGIN_SRC, path.join(tmp, 'after-seed-layer.js'));
const { default: AfterSeedLayer } = await import(pathToFileURL(path.join(tmp, 'after-seed-layer.js')));

// --- fake weekday (server time) -------------------------------------------------
const realGetDay = Date.prototype.getDay;
const weekday = (n) => { Date.prototype.getDay = () => n; }; // 0 = sunday ... 6 = saturday
weekday(3); // wednesday unless a scenario says otherwise

// --- tiny assert ----------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };

// --- mocks ----------------------------------------------------------------------
const LAYERS = {
  monday: 'Mon_AAS_v1 USA RGF', tuesday: 'Tue_AAS_v1 USA RGF', wednesday: 'Wed_RAAS_v1 BAF PLA',
  thursday: 'Thu_AAS_v1 USA RGF', friday: 'Fri_AAS_v1 USA RGF', saturday: 'Sat_AAS_v1 USA RGF',
  sunday: 'Sun_AAS_v1 USA RGF'
};
const SET_WED = 'AdminSetNextLayer Wed_RAAS_v1 BAF PLA';
const SEED = { name: 'Mutaha Seed v1', classname: 'Mutaha', layerid: 'Mutaha_Seed_v1', gamemode: 'Seed' };
const RAAS = { name: 'Mutaha RAAS v2', classname: 'Mutaha', layerid: 'Mutaha_RAAS_v2', gamemode: 'RAAS' };

// Like the real SquadServer, `nextLayerToBeVoted` only reflects Squad's next layer
// after updateLayerInformation() (or the next 30s layer poll).
class MockServer extends EventEmitter {
  constructor({ currentLayer = SEED, squadNextLayer = null } = {}) {
    super(); this.currentLayer = currentLayer; this.squadNextLayer = squadNextLayer;
    this.nextLayerToBeVoted = squadNextLayer === null;
    this.commands = []; this.ignoreClear = false; this.failRcon = false; const self = this;
    this.rcon = { execute: async (cmd) => {
      if (self.failRcon) throw new Error('Not connected.');
      if (cmd === 'ShowNextMap') return self.squadNextLayer
        ? `Next level is X, layer is ${self.squadNextLayer.replace(' ', ', factions ')}`
        : 'Next level is , layer is To be voted';
      self.commands.push(cmd);
      if (cmd.startsWith('AdminSetNextLayer ')) self.squadNextLayer = cmd.slice('AdminSetNextLayer '.length);
      if (cmd === 'AdminClearNextLayer' && !self.ignoreClear) self.squadNextLayer = null;
      return '';
    }, getNextMap: async () => {
      if (self.failRcon) throw new Error('Not connected.');
      return { layer: self.squadNextLayer?.split(' ')[0] ?? null, toBeVoted: self.squadNextLayer === null };
    } };
  }
  async updateLayerInformation() { this.nextLayerToBeVoted = this.squadNextLayer === null; }
}

// UPDATED_SERVER_INFORMATION payload as built by SquadServer.updateServerInformation().
const info = (playerCount, layer) => ({
  serverName: 'Test', maxPlayers: 100, publicQueueLimit: 25, reserveSlots: 2,
  playerCount, a2sPlayerCount: playerCount, publicQueue: 0, reserveQueue: 0,
  currentLayer: layer?.layerid, nextLayer: '', teamOne: 'USA', teamTwo: 'RGF',
  matchTimeout: 0, matchStartTime: null, gameVersion: 'v10.6'
});

// Awaits every listener the plugin registered, like the server emitting the event.
const fire = (server, event, payload) => Promise.all(server.listeners(event).map((fn) => fn(payload)));
const players = (server, n) => fire(server, 'UPDATED_SERVER_INFORMATION', info(n, server.currentLayer));

async function makePlugin(serverOpts, opts = {}) {
  const server = new MockServer(serverOpts);
  const plugin = new AfterSeedLayer(server, { setThreshold: 50, clearThreshold: 80, layers: LAYERS, ...opts });
  const logs = [];
  plugin.verbose = (level, ...msg) => logs.push(msg);
  await plugin.mount();
  return { server, plugin, logs };
}

// === Scenario 1: sets the weekday layer once the seed reaches setThreshold ========
{
  const { server } = await makePlugin();
  await players(server, 49); ok(server.commands.length === 0, 'S1 nothing below setThreshold (49)');
  await players(server, 50); ok(server.commands.join() === SET_WED, 'S1 sets the wednesday layer at setThreshold (50)');
  await players(server, 60); ok(server.commands.length === 1, 'S1 does not set a second time');
}

// === Scenario 2: the layer follows the server weekday ==========================
{
  weekday(0);
  const { server } = await makePlugin();
  await players(server, 55);
  ok(server.commands.join() === 'AdminSetNextLayer Sun_AAS_v1 USA RGF', 'S2 getDay 0 picks the sunday layer');
  weekday(3);
}

// === Scenario 3: only acts on seed layers =======================================
{
  const { server } = await makePlugin({ currentLayer: RAAS });
  await players(server, 60); await players(server, 90);
  ok(server.commands.length === 0, 'S3 no command on a non-seed layer');
  const { server: unknown } = await makePlugin({ currentLayer: null });
  await players(unknown, 60);
  ok(unknown.commands.length === 0, 'S3 no command while the current layer is unknown');
}

// === Scenario 4: never touches a next layer an admin set ========================
{
  const { server } = await makePlugin({ squadNextLayer: 'Narva_RAAS_v1 CAF IMF' });
  await players(server, 60); ok(server.commands.length === 0, 'S4 admin-set next layer is not overridden');
  await players(server, 90); ok(server.commands.length === 0, 'S4 admin-set next layer is not cleared above clearThreshold');
}

// === Scenario 5: clears its own layer once the seed round gets too full =========
{
  const { server } = await makePlugin();
  await players(server, 50);
  await players(server, 80); ok(server.commands.length === 1, 'S5 no clear at clearThreshold (80)');
  await players(server, 81); ok(server.commands[1] === 'AdminClearNextLayer', 'S5 clears above clearThreshold (81)');
  await players(server, 85); await players(server, 60);
  ok(server.commands.length === 2, 'S5 nothing more this round (no re-clear, no re-set)');
}

// === Scenario 6: logs when AdminClearNextLayer does not take ====================
{
  const cleared = await makePlugin();
  await players(cleared.server, 50); await players(cleared.server, 81);
  const ignored = await makePlugin();
  ignored.server.ignoreClear = true;
  await players(ignored.server, 50); await players(ignored.server, 81);
  ok(ignored.logs.length === cleared.logs.length + 1, 'S6 one extra log line when the next layer is still set after clearing');
}

// === Scenario 7: never sets when the seed is already past clearThreshold ========
{
  const { server } = await makePlugin();
  await players(server, 90); ok(server.commands.length === 0, 'S7 no command when jumping straight to 90');
}

// === Scenario 8: ROUND_ENDED freezes the round, NEW_GAME starts over ============
{
  const { server } = await makePlugin();
  await players(server, 55);
  await fire(server, 'ROUND_ENDED', { winner: null, loser: null, time: new Date() });
  await players(server, 90); ok(server.commands.length === 1, 'S8 no clear after ROUND_ENDED (the set layer is about to load)');
  server.squadNextLayer = null; server.nextLayerToBeVoted = true; // next seed round starts with a vote pending
  await fire(server, 'NEW_GAME', { dlc: null, mapClassname: 'Mutaha', layerClassname: 'Mutaha_Seed_v1', layer: SEED, time: new Date() });
  await players(server, 55); ok(server.commands[1] === SET_WED, 'S8 sets again after NEW_GAME');
}

// === Scenario 9: no layer configured for today ==================================
{
  const { server } = await makePlugin(undefined, { layers: { monday: 'Mon_AAS_v1 USA RGF' } });
  await players(server, 60); ok(server.commands.length === 0, 'S9 no command when today has no layer');
}

// === Scenario 10: an RCON error stays inside the handler ========================
{
  const { server } = await makePlugin();
  server.failRcon = true;
  let threw = false;
  try { await players(server, 60); } catch { threw = true; }
  ok(!threw, 'S10 an RCON error does not escape the handler');
}

// === Scenario 11: unmount removes every listener mount added ====================
{
  const { server, plugin } = await makePlugin();
  const events = ['UPDATED_SERVER_INFORMATION', 'NEW_GAME', 'ROUND_ENDED'];
  ok(events.every((e) => server.listenerCount(e) === 1), 'S11 mount registers one listener per event');
  await plugin.unmount();
  ok(events.every((e) => server.listenerCount(e) === 0), 'S11 unmount removes them all');
}

// === Scenario 12: clearThreshold 0 disables clearing ===========================
{
  const { server } = await makePlugin(undefined, { clearThreshold: 0 });
  await players(server, 90); ok(server.commands.join() === SET_WED, 'S12 sets when jumping straight to 90');
  await players(server, 100); ok(server.commands.length === 1, 'S12 never clears');
}
// --- summary --------------------------------------------------------------------
Date.prototype.getDay = realGetDay;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} assertions passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
